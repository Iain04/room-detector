# gotroom

WiFi CSI/RSSI motion detection prototype. The ESP32 publishes motion events to
MQTT; the Next.js app subscribes, keeps a small in-memory history, and shows it
at `http://localhost:3000`.

## Run locally

Install [Node.js 20 or newer](https://nodejs.org/) and pnpm, then run:

```powershell
pnpm install
Copy-Item .env.example .env.local
pnpm dev
```

Open `http://localhost:3000`. Dependencies are intentionally not committed;
`pnpm-lock.yaml` makes `pnpm install` reproduce the team dependency set.

## MQTT contract

Set `MQTT_URL` in `.env.local` to your broker (and optional credentials in the
URL), then publish JSON to `MQTT_MOTION_EVENTS_TOPIC`, which defaults to
`room-detector/motion-events`. The payload is the existing motion-event JSON;
`GET /api/motion-events?limit=10` remains the dashboard history endpoint.
`POST /api/motion-events` now returns `410 Gone`.

The backend ignores readings with `packet_rate < 50`, removes duplicate
timestamps, and uses a per-device 10-second window with at least 8 calibrated,
reliable samples. It then computes the median `baseline_diff`. It flags activity when the absolute
deviation from the empty-room reference exceeds
`MOTION_BASELINE_DIFF_TOLERANCE`. The latest labelled study-room captures
calibrated the reference median to `0.348` and tolerance to `0.074`. Recalculate these
values from a fresh empty-room capture whenever the room or device placement
changes. RSSI is retained for diagnostics but is not used for detection.

For a local broker with Docker:

```powershell
docker run --rm -p 1883:1883 --name room-detector-mqtt eclipse-mosquitto
```

## Publish a test event

```powershell
$body = @{ device_id = 'esp32-rx-01'; room_id = 'study-room-2'; ts = 1790169216838; timestamp = '2026-09-23T13:13:36.838Z'; motion_score = 2.035; motion_excess = 0.406; motion_max = 4.89; baseline_diff = 0.114; rssi = -42; packet_rate = 101; calibrated = $true } | ConvertTo-Json -Compress
pnpm exec mqtt pub -h localhost -t room-detector/motion-events -m $body -q 1
```

Then inspect `http://localhost:3000/api/motion-events?limit=10` or the
dashboard. The in-memory event list resets whenever the server restarts.

## CSV captures

Every valid MQTT reading is appended to a timestamped CSV under `data/` for
the lifetime of the server process. Stop the server after the empty-room run;
the next server start creates a new CSV for the activity run. Set
`MOTION_CSV_PATH=data/empty-room.csv` in `.env.local` only when you want an
explicit filename. Capture files include raw telemetry, packet reliability,
the 10-second decision, confidence, and rolling-window statistics.
