"use client";

import { useEffect, useState } from "react";

type MotionEvent = {
  device_id: string;
  room_id?: string;
  timestamp: string;
  motion_detected: boolean;
  confidence: number;
};

export default function Home() {
  const [events, setEvents] = useState<MotionEvent[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    async function refresh() {
      try {
        const response = await fetch("/api/motion-events?limit=10", { cache: "no-store" });
        if (!response.ok) throw new Error("Could not load motion events");
        setEvents(await response.json());
        setError("");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not load motion events");
      }
    }

    refresh();
    const timer = window.setInterval(refresh, 2_000);
    return () => window.clearInterval(timer);
  }, []);

  const latest = events[0];
  return (
    <main style={{ fontFamily: "system-ui", margin: "3rem auto", maxWidth: 720 }}>
      <h1>Room Detector</h1>
      <p>Polling every 2 seconds.</p>
      {error ? <p role="alert">{error}</p> : null}
      <h2>{latest?.motion_detected ? "Motion detected" : "No current motion"}</h2>
      <p>{latest ? `${latest.device_id} · ${Math.round(latest.confidence * 100)}% confidence` : "Waiting for an ESP32 event…"}</p>
      <h3>Recent events</h3>
      <ol>
        {events.map((event, index) => (
          <li key={`${event.device_id}-${event.timestamp}-${index}`}>
            {new Date(event.timestamp).toLocaleTimeString()} — {event.room_id ?? "unknown room"}: {event.motion_detected ? "motion" : "clear"}
          </li>
        ))}
      </ol>
    </main>
  );
}
