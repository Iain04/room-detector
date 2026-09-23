/**
 * Deliberately small, process-local event store for the hackathon demo.
 * Keeping this module separate means it can later be replaced with Redis or a
 * database without changing the HTTP route.
 */

export type MotionEvent = {
  device_id: string;
  timestamp: string;
  motion_detected: boolean;
  confidence: number;
  raw_metric?: number;
  room_id?: string;
  ts?: number;
  motion_score?: number;
  motion_max?: number;
  baseline_diff?: number;
  rssi?: number;
  packet_rate?: number;
};

const MAX_EVENTS = 1_000;

// Retain the store during Next.js development hot reloads.
const store = globalThis as typeof globalThis & {
  __motionEvents?: MotionEvent[];
};

const events = (store.__motionEvents ??= []);

export function addMotionEvent(event: MotionEvent) {
  events.unshift(event);
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
  return event;
}

export function getMotionEvents(limit: number) {
  return events.slice(0, limit);
}

export function parseLimit(value: string | null) {
  if (value === null) return 100;
  if (!/^\d+$/.test(value)) return null;

  const limit = Number(value);
  return limit >= 1 && limit <= 500 ? limit : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Supports the agreed HTTP contract and the CSI telemetry shape supplied for
 * this prototype. Detailed CSI messages are normalized into the agreed fields.
 */
export function parseMotionEvent(body: unknown): MotionEvent | null {
  if (!isRecord(body)) return null;

  const deviceId = optionalString(body.device_id);
  if (!deviceId) return null;

  const timestamp = optionalString(body.timestamp);
  const motionDetected = body.motion_detected;
  const confidence = optionalNumber(body.confidence);
  const rawMetric = optionalNumber(body.raw_metric);

  // Original DATA CONTRACT.
  if (
    timestamp &&
    !Number.isNaN(Date.parse(timestamp)) &&
    typeof motionDetected === "boolean" &&
    confidence !== undefined &&
    confidence >= 0 &&
    confidence <= 1 &&
    (body.raw_metric === undefined || rawMetric !== undefined)
  ) {
    return {
      device_id: deviceId,
      timestamp: new Date(timestamp).toISOString(),
      motion_detected: motionDetected,
      confidence,
      ...(rawMetric === undefined ? {} : { raw_metric: rawMetric }),
      ...(optionalString(body.room_id) ? { room_id: optionalString(body.room_id) } : {}),
    };
  }

  // CSI telemetry shape: derive the dashboard-compatible status from score.
  const ts = optionalNumber(body.ts);
  const motionScore = optionalNumber(body.motion_score);
  const motionMax = optionalNumber(body.motion_max);
  const baselineDiff = optionalNumber(body.baseline_diff);
  const rssi = optionalNumber(body.rssi);
  const packetRate = optionalNumber(body.packet_rate);
  const roomId = optionalString(body.room_id);

  if (
    !roomId ||
    ts === undefined ||
    !Number.isInteger(ts) ||
    ts <= 0 ||
    motionScore === undefined ||
    motionScore < 0 ||
    motionMax === undefined ||
    baselineDiff === undefined ||
    rssi === undefined ||
    packetRate === undefined ||
    packetRate < 0
  ) {
    return null;
  }

  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return null;

  return {
    device_id: deviceId,
    room_id: roomId,
    ts,
    timestamp: date.toISOString(),
    // Hackathon default: firmware can use the original contract to select a
    // different threshold explicitly.
    motion_detected: motionScore >= 0.5,
    confidence: Math.min(1, motionScore),
    raw_metric: baselineDiff,
    motion_score: motionScore,
    motion_max: motionMax,
    baseline_diff: baselineDiff,
    rssi,
    packet_rate: packetRate,
  };
}
