# Room Detector

Wi-Fi room occupancy sensing for energy saving. An ESP32-S3 measures Wi-Fi
Channel State Information (CSI), publishes 1-second motion telemetry over MQTT,
and a Next.js backend stores and displays it.

```
ESP32-S3 (esp32/) ──MQTT: room-detector/motion-events──► broker ──► Next.js (backend/)
```

## Repository layout

| Folder | What it is |
|---|---|
| [`backend/`](backend/) | Next.js app: MQTT subscriber, `GET /api/motion-events`, dashboard. See [backend/README.md](backend/README.md). |
| [`esp32/`](esp32/) | ESP-IDF firmware for the ESP32-S3 (C). |
| `esp32/firmware/receiver/` | Main firmware: measures CSI and publishes telemetry. |
| `esp32/firmware/sender/` | Optional second board for two-ESP32 mode. |
| `esp32/firmware/hello_test/` | Minimal upload test. |

## MQTT contract

Telemetry, every second, QoS 1, topic `room-detector/motion-events`:

```json
{"device_id":"esp32-rx-01","room_id":"study-room-2","ts":1790169216838,
 "timestamp":"2026-09-23T13:13:36.838Z","motion_score":2.035,"motion_excess":0.406,
 "motion_max":4.890,"baseline_diff":0.114,"rssi":-42,"packet_rate":101,"calibrated":true}
```

| Field | Meaning |
|---|---|
| `ts` | Unix epoch ms (0 until the device clock syncs) |
| `timestamp` | Same time as ISO 8601 UTC string (`null` until the clock syncs) |
| `motion_score` | Mean CSI amplitude std-dev over the second — raw movement (empty room is not 0) |
| `motion_excess` | `motion_score` minus the empty-room noise floor, ≥ 0; `0` = as quiet as empty. `null` until calibrated. Best field for motion thresholds |
| `motion_max` | Largest packet-to-packet change — sudden movement |
| `baseline_diff` | Difference from the calibrated empty room — detects people sitting still |
| `rssi` | Mean signal strength (dBm) |
| `packet_rate` | CSI packets that second (~100); below 50 the reading is unreliable |
| `calibrated` | Calibrated since last boot. `false` means ignore `motion_excess` and `baseline_diff` |

Other topics:

| Topic | Direction | Payload |
|---|---|---|
| `devices/{device_id}/heartbeat` | device → backend, every 60 s | `{"device_id","ts","uptime_s","firmware"}` |
| `devices/{device_id}/status` | device → backend | `{"event":"calibration_started" \| "calibration_done" \| "calibration_failed", ...}`; `calibration_done` includes `noise_floor` |
| `devices/{device_id}/cmd` | backend → device | `{"cmd":"calibrate","seconds":60}` — record the empty-room baseline |

The firmware only measures; occupancy decisions belong in the backend.

## Quick start

### 1. MQTT broker

Public test broker (no setup): `mqtt://broker.hivemq.com:1883`.

Or a local broker on the laptop (accepts connections from the ESP32):

```powershell
docker run --rm -p 1883:1883 --name room-detector-mqtt eclipse-mosquitto mosquitto -c /mosquitto-no-auth.conf
```

The ESP32 must use the laptop's LAN IP (not `localhost`), be on the same
Wi-Fi, and Windows Firewall may need to allow inbound TCP 1883.

### 2. Backend

```powershell
cd backend
pnpm install
Copy-Item .env.example .env.local   # set MQTT_URL to your broker
pnpm dev                            # http://localhost:3000
```

### 3. ESP32-S3 firmware

Requires ESP-IDF v5.1+ (tested on v6.1) and a 2.4 GHz network.

```powershell
cd esp32
Copy-Item .env.example .env         # Wi-Fi, MQTT_BROKER_URL, IDs
cd firmware\receiver
..\..\idf -p COM4 flash monitor     # or idf.py from an ESP-IDF terminal
```

`esp32/idf.cmd` runs `idf.py` from a normal cmd/PowerShell window; it expects
ESP-IDF v6.1 installed by the ESP-IDF Installation Manager.

**CSI source** (`CSI_SOURCE` in `esp32/.env`):
- `router` (default) — one ESP32 pings the Wi-Fi router 100×/s and measures the replies.
- `sender` — a second ESP32 runs `firmware/sender`; set it to the router's channel
  and put its MAC in `SENDER_MAC`.

**Calibrate** once the boards are in place and the room is empty. Calibration is
kept in RAM only (set `CSI_PERSIST_BASELINE` in menuconfig to save it), so it is
lost on every reboot — including when `idf.py monitor` connects — and must be resent:

```powershell
cd backend
pnpm exec mqtt pub -h <broker> -t devices/esp32-rx-01/cmd -m '{"cmd":"calibrate","seconds":60}'
```

## Notes

- Thresholds must be tuned per room: record `motion_score` while the room is
  still and while people move, then pick a value between them.
- Phone hotspots drop pings (low `packet_rate`); a real router gives cleaner data.
- CSI sensing is an estimate, not a safety or security system.
