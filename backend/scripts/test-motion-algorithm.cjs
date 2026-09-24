const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const source = fs.readFileSync(path.join("lib", "motion-events.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleUnderTest = { exports: {} };
new Function("exports", "require", "module", compiled)(moduleUnderTest.exports, require, moduleUnderTest);

const { addMotionEvent, parseMotionEvent } = moduleUnderTest.exports;

function publish(overrides = {}) {
  const event = parseMotionEvent({
    device_id: "test-devkit",
    room_id: "test-room",
    ts: 1790172000000,
    motion_score: 1.1,
    motion_excess: 0.1,
    motion_max: 2,
    baseline_diff: 0.05,
    rssi: -60,
    packet_rate: 100,
    calibrated: true,
    ...overrides,
  });
  assert.ok(event, "fixture must be valid telemetry");
  return addMotionEvent(event);
}

// The first ten seconds are deliberately a warm-up period.
const warmup = publish({ device_id: "warmup-devkit" });
assert.equal(warmup.decision, "warming_up");
assert.equal(warmup.motion_detected, false);

// A cleaned ten-second window that differs materially from the empty-room baseline.
let activeWindow;
const start = 1790172000000;
for (let second = 0; second <= 10; second += 1) {
  activeWindow = publish({
    device_id: "active-devkit",
    ts: start + second * 1000,
    motion_score: 2.1,
    motion_excess: 0.7,
    baseline_diff: 0.25,
  });
}
assert.equal(activeWindow.decision, "present");
assert.equal(activeWindow.motion_detected, true);
assert.ok(activeWindow.confidence > 0);
assert.equal(activeWindow.window.reliable_sample_count, 11);

// Once the last ten seconds return to the empty-room band, occupancy clears.
let clearWindow;
for (let second = 11; second <= 21; second += 1) {
  clearWindow = publish({
    device_id: "active-devkit",
    ts: start + second * 1000,
    motion_score: 1.1,
    motion_excess: 0.1,
    baseline_diff: 0.4115,
  });
}
assert.equal(clearWindow.decision, "clear");
assert.equal(clearWindow.motion_detected, false);

// Low packet-rate data is stored as ignored and cannot trigger motion.
const ignored = publish({
  device_id: "unreliable-devkit",
  packet_rate: 11,
  motion_excess: 0.9,
});
assert.equal(ignored.decision, "ignored");
assert.equal(ignored.motion_detected, false);

console.log("Motion algorithm tests passed.");
