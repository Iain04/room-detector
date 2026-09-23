import { getMotionEvents, parseLimit } from "../../../lib/motion-events";
import { ensureMqttMotionSubscriber, getMotionEventsTopic } from "../../../lib/mqtt-motion-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST() {
  return Response.json(
    {
      error: "HTTP event ingestion has moved to MQTT.",
      topic: getMotionEventsTopic(),
    },
    { status: 410 },
  );
}

export function GET(request: Request) {
  ensureMqttMotionSubscriber();
  const limit = parseLimit(new URL(request.url).searchParams.get("limit"));
  if (limit === null) {
    return Response.json(
      { error: "limit must be an integer from 1 to 500." },
      { status: 400 },
    );
  }

  return Response.json(getMotionEvents(limit), {
    headers: { "Cache-Control": "no-store" },
  });
}
