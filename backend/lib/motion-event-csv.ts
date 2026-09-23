import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { MotionEvent } from "./motion-events";

const header = [
  "received_at", "device_id", "room_id", "timestamp", "ts",
  "motion_score", "motion_excess", "motion_max", "baseline_diff", "rssi", "packet_rate", "calibrated",
  "reliable", "decision", "motion_detected", "confidence",
  "window_duration_ms", "window_sample_count", "window_reliable_sample_count", "window_baseline_median", "window_baseline_deviation", "window_baseline_tolerance",
].join(",");

const csvStore = globalThis as typeof globalThis & { __motionCsvPath?: string };
const csvPath = (csvStore.__motionCsvPath ??= process.env.MOTION_CSV_PATH
  ? resolve(process.cwd(), process.env.MOTION_CSV_PATH)
  : resolve(process.cwd(), "data", `motion-events-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`));

function csvValue(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export function getMotionCsvPath() {
  return csvPath;
}

/** Appends one validated MQTT reading. A new default file is created per server run. */
export function appendMotionEventToCsv(event: MotionEvent) {
  mkdirSync(dirname(csvPath), { recursive: true });
  if (!existsSync(csvPath)) appendFileSync(csvPath, `${header}\n`, "utf8");

  const row = [
    new Date().toISOString(), event.device_id, event.room_id, event.timestamp, event.ts,
    event.motion_score, event.motion_excess, event.motion_max, event.baseline_diff, event.rssi, event.packet_rate, event.calibrated,
    event.reliable, event.decision, event.motion_detected, event.confidence,
    event.window?.duration_ms, event.window?.sample_count, event.window?.reliable_sample_count, event.window?.baseline_median, event.window?.baseline_deviation, event.window?.baseline_tolerance,
  ].map(csvValue).join(",");
  appendFileSync(csvPath, `${row}\n`, "utf8");
}
