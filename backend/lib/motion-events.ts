/** Process-local event store and fast, cleaned-window motion classifier. */
export type MotionDecision = "present" | "clear" | "ignored" | "warming_up";

export type MotionWindow = {
  duration_ms: number;
  sample_count: number;
  reliable_sample_count: number;
  calibrated_sample_count: number;
  baseline_median?: number;
  baseline_deviation?: number;
  baseline_tolerance?: number;
};

export type MotionEvent = {
  device_id: string;
  room_id?: string;
  timestamp: string;
  ts?: number;
  motion_detected: boolean;
  confidence: number;
  decision: MotionDecision;
  reliable: boolean;
  window?: MotionWindow;
  raw_metric?: number;
  motion_score?: number;
  motion_excess?: number | null;
  motion_max?: number;
  baseline_diff?: number;
  rssi?: number;
  packet_rate?: number;
  calibrated?: boolean;
};

const MAX_EVENTS = 1_000;
const MIN_RELIABLE_PACKET_RATE = 50;
const WINDOW_MS = 10 * 1_000; // 10 seconds
const MIN_RELIABLE_SAMPLES = 8; // require at least 8 good readings
// Calibrated from the current labelled captures in backend/data.
const DEFAULT_BASELINE_MEDIAN = 0.348;
const DEFAULT_BASELINE_TOLERANCE = 0.074;
const store = globalThis as typeof globalThis & { __motionEvents?: MotionEvent[] };
const events = (store.__motionEvents ??= []);

export function addMotionEvent(event: MotionEvent) {
  events.unshift(event);
  applyRollingMotionDecision(event);
  const status = event.decision === "present"
    ? "OCCUPIED"
    : event.decision === "clear"
      ? "VACANT"
      : event.decision === "ignored"
        ? "SIGNAL UNRELIABLE"
        : "CALIBRATING";
  console.log(`[occupancy] room=${event.room_id ?? "unknown"} device=${event.device_id} status=${status}`);
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
  return event;
}

export function getMotionEvents(limit: number) { return events.slice(0, limit); }
export function parseLimit(value: string | null) {
  if (value === null) return 100;
  if (!/^\d+$/.test(value)) return null;
  const limit = Number(value);
  return limit >= 1 && limit <= 500 ? limit : null;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function optionalString(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function optionalNumber(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function clamp(value: number) { return Math.min(1, Math.max(0, value)); }
function numericEnvironmentValue(name: string, fallback: number) {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) && configured >= 0 ? configured : fallback;
}
function baselineMedian() { return numericEnvironmentValue("MOTION_BASELINE_DIFF_MEDIAN", DEFAULT_BASELINE_MEDIAN); }
function baselineTolerance() { return numericEnvironmentValue("MOTION_BASELINE_DIFF_TOLERANCE", DEFAULT_BASELINE_TOLERANCE); }
function eventTime(timestampValue: unknown, tsValue: unknown) {
  const timestamp = optionalString(timestampValue);
  if (timestamp && !Number.isNaN(Date.parse(timestamp))) {
    const date = new Date(timestamp);
    return { timestamp: date.toISOString(), ts: date.getTime() };
  }
  const ts = optionalNumber(tsValue);
  if (ts !== undefined && Number.isInteger(ts) && ts > 0) {
    const date = new Date(ts);
    if (!Number.isNaN(date.getTime())) return { timestamp: date.toISOString(), ts };
  }
  const receivedAt = new Date();
  return { timestamp: receivedAt.toISOString(), ts: receivedAt.getTime() };
}
function eventTimeMs(event: MotionEvent) { return event.ts ?? Date.parse(event.timestamp); }
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
function uniqueEventsByTimestamp(eventsToClean: MotionEvent[]) {
  const seen = new Set<number>();
  return eventsToClean.filter((event) => {
    const timestamp = eventTimeMs(event);
    if (seen.has(timestamp)) return false;
    seen.add(timestamp);
    return true;
  });
}

/**
 * Classifies activity over the previous ten seconds for one device/room.
 * It compares the window's median baseline_diff with an empty-room reference.
 * packet_rate only gates data quality; RSSI is not used as a motion signal.
 */
function applyRollingMotionDecision(current: MotionEvent) {
  if (current.motion_score === undefined || !current.reliable) return;

  const end = eventTimeMs(current);
  // Clean the live window before calculating: same sensor/room only, one
  // reading per timestamp, and only calibrated reliable baseline readings.
  const windowEvents = uniqueEventsByTimestamp(events.filter((event) =>
    event.device_id === current.device_id &&
    event.room_id === current.room_id &&
    event.motion_score !== undefined &&
    eventTimeMs(event) >= end - WINDOW_MS && eventTimeMs(event) <= end,
  ));
  const reliableEvents = windowEvents.filter((event) => event.reliable);
  const calibratedBaselineEvents = reliableEvents.filter(
    (event) => event.calibrated && event.baseline_diff !== undefined && Number.isFinite(event.baseline_diff),
  );
  const timestamps = calibratedBaselineEvents.map(eventTimeMs);
  const durationMs = timestamps.length ? end - Math.min(...timestamps) : 0;
  const baseWindow: MotionWindow = {
    duration_ms: Math.max(0, durationMs),
    sample_count: windowEvents.length,
    reliable_sample_count: reliableEvents.length,
    calibrated_sample_count: calibratedBaselineEvents.length,
  };

  if (durationMs < WINDOW_MS || calibratedBaselineEvents.length < MIN_RELIABLE_SAMPLES) {
    current.motion_detected = false;
    current.confidence = 0;
    current.decision = "warming_up";
    current.window = baseWindow;
    return;
  }

  const calibratedBaselineDiffs = calibratedBaselineEvents.map((event) => event.baseline_diff!);

  const emptyRoomMedian = baselineMedian();
  const tolerance = baselineTolerance();
  const windowMedian = median(calibratedBaselineDiffs);
  const deviation = Math.abs(windowMedian - emptyRoomMedian);
  const motionDetected = deviation > tolerance;
  const coverage = clamp(calibratedBaselineEvents.length / (WINDOW_MS / 1_000));
  const confidence = clamp(0.5 + (deviation - tolerance) / (2 * tolerance)) * coverage;

  current.motion_detected = motionDetected;
  current.confidence = confidence;
  current.decision = motionDetected ? "present" : "clear";
  current.window = {
    ...baseWindow,
    baseline_median: windowMedian,
    baseline_deviation: deviation,
    baseline_tolerance: tolerance,
  };
}

/** Parses the original contract plus the ESP32-S3 MQTT telemetry contract. */
export function parseMotionEvent(body: unknown): MotionEvent | null {
  if (!isRecord(body)) return null;
  const deviceId = optionalString(body.device_id);
  if (!deviceId) return null;

  const legacyTimestamp = optionalString(body.timestamp);
  const legacyConfidence = optionalNumber(body.confidence);
  const legacyRawMetric = optionalNumber(body.raw_metric);
  if (legacyTimestamp && !Number.isNaN(Date.parse(legacyTimestamp)) && typeof body.motion_detected === "boolean" && legacyConfidence !== undefined && legacyConfidence >= 0 && legacyConfidence <= 1 && (body.raw_metric === undefined || legacyRawMetric !== undefined)) {
    const time = eventTime(legacyTimestamp, undefined);
    return { device_id: deviceId, timestamp: time.timestamp, ts: time.ts, motion_detected: body.motion_detected, confidence: legacyConfidence, decision: body.motion_detected ? "present" : "clear", reliable: true, ...(legacyRawMetric === undefined ? {} : { raw_metric: legacyRawMetric }), ...(optionalString(body.room_id) ? { room_id: optionalString(body.room_id) } : {}) };
  }

  const roomId = optionalString(body.room_id);
  const motionScore = optionalNumber(body.motion_score);
  const motionMax = optionalNumber(body.motion_max);
  const baselineDiff = optionalNumber(body.baseline_diff);
  const rssi = optionalNumber(body.rssi);
  const packetRate = optionalNumber(body.packet_rate);
  const motionExcess = body.motion_excess === null ? null : optionalNumber(body.motion_excess);
  const calibrated = body.calibrated;
  const invalidMotionExcess = motionExcess === undefined || (motionExcess !== null && motionExcess < 0);
  if (!roomId || motionScore === undefined || motionScore < 0 || motionMax === undefined || motionMax < 0 || baselineDiff === undefined || baselineDiff < 0 || rssi === undefined || packetRate === undefined || packetRate < 0 || !Number.isInteger(packetRate) || typeof calibrated !== "boolean" || (body.motion_excess !== null && invalidMotionExcess) || (calibrated && motionExcess === null)) return null;

  const time = eventTime(body.timestamp, body.ts);
  const reliable = packetRate >= MIN_RELIABLE_PACKET_RATE;
  return {
    device_id: deviceId, room_id: roomId, ...time, reliable,
    motion_detected: false, confidence: 0, decision: reliable ? "warming_up" : "ignored",
    raw_metric: calibrated ? motionExcess! : motionScore,
    motion_score: motionScore, motion_excess: motionExcess, motion_max: motionMax,
    baseline_diff: baselineDiff, rssi, packet_rate: packetRate, calibrated,
  };
}
