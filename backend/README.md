# Room Detector

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
no data fields have changed. `GET /api/motion-events?limit=10` remains the
dashboard history endpoint. `POST /api/motion-events` now returns `410 Gone`.

For a local broker with Docker:

```powershell
docker run --rm -p 1883:1883 --name room-detector-mqtt eclipse-mosquitto
```

## Publish a test event

```powershell
$body = @{ device_id = 'esp32-rx-01'; room_id = 'study-room-2'; ts = 1790138400123; motion_score = 0.82; motion_max = 1.4; baseline_diff = 0.35; rssi = -48; packet_rate = 98 } | ConvertTo-Json -Compress
pnpm exec mqtt pub -h localhost -t room-detector/motion-events -m $body -q 1
```

Then inspect `http://localhost:3000/api/motion-events?limit=10` or the
dashboard. The in-memory event list resets whenever the server restarts.
