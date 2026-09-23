import mqtt, { type MqttClient } from "mqtt";
import { addMotionEvent, parseMotionEvent } from "./motion-events";

const DEFAULT_TOPIC = "room-detector/motion-events";

type MqttBridge = {
  client?: MqttClient;
  started: boolean;
};

const globalStore = globalThis as typeof globalThis & {
  __mqttMotionBridge?: MqttBridge;
};

const bridge = (globalStore.__mqttMotionBridge ??= { started: false });

export function getMotionEventsTopic() {
  return process.env.MQTT_MOTION_EVENTS_TOPIC || DEFAULT_TOPIC;
}

/** Starts one MQTT subscriber per Next.js process. */
export function ensureMqttMotionSubscriber() {
  if (bridge.started) return;
  bridge.started = true;

  const brokerUrl = process.env.MQTT_URL;
  if (!brokerUrl) {
    console.warn("MQTT subscriber not started: set MQTT_URL in .env.local.");
    return;
  }

  const topic = getMotionEventsTopic();
  const client = mqtt.connect(brokerUrl, {
    reconnectPeriod: 2_000,
    clientId: `room-detector-dashboard-${process.pid}`,
  });
  bridge.client = client;

  client.on("connect", () => {
    client.subscribe(topic, { qos: 1 }, (error) => {
      if (error) console.error("MQTT subscription failed:", error.message);
      else console.info(`Subscribed to MQTT topic: ${topic}`);
    });
  });

  client.on("message", (receivedTopic, payload) => {
    if (receivedTopic !== topic) return;

    try {
      const event = parseMotionEvent(JSON.parse(payload.toString("utf8")));
      if (!event) {
        console.warn("Discarded invalid MQTT motion event.");
        return;
      }
      addMotionEvent(event);
    } catch {
      console.warn("Discarded MQTT motion event with invalid JSON.");
    }
  });

  client.on("error", (error) => console.error("MQTT client error:", error.message));
}
