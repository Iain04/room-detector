"use client";

import { useEffect, useState } from "react";

type MotionEvent = {
  device_id: string;
  room_id?: string;
  timestamp: string;
  motion_detected: boolean;
  confidence: number;
  decision: "present" | "clear" | "ignored" | "warming_up";
  motion_score?: number;
  motion_excess?: number | null;
  packet_rate?: number;
  calibrated?: boolean;
  window?: {
    duration_ms: number;
    reliable_sample_count: number;
    baseline_median?: number;
    baseline_deviation?: number;
  };
};

export default function Home() {
  const [events, setEvents] = useState<MotionEvent[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    async function refresh() {
      try {
        const response = await fetch("/api/motion-events?limit=10", { cache: "no-store" });
        if (!response.ok) throw new Error("Could not load motion events");
        const motionEvents: MotionEvent[] = await response.json();
        console.log("[dashboard] motion events", motionEvents);
        setEvents(motionEvents);
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
      <h2>{latest?.decision === "warming_up" ? "Collecting a 3-minute motion window" : latest?.decision === "ignored" ? "Signal unreliable" : latest?.motion_detected ? "Motion detected" : "No motion in the window"}</h2>
      <p>{latest ? `${latest.device_id} · ${latest.packet_rate ?? "?"} packets/s · ${latest.calibrated ? "calibrated" : "provisional"} · ${latest.window ? `${Math.round(latest.window.duration_ms / 1000)}s collected` : "no window yet"}` : "Waiting for an ESP32 event…"}</p>
      {latest?.window?.baseline_deviation !== undefined ? <p>Baseline deviation: {latest.window.baseline_deviation.toFixed(3)}</p> : null}
      <h3>Recent events</h3>
      <ol>
        {events.map((event, index) => (
          <li key={`${event.device_id}-${event.timestamp}-${index}`}>
            {new Date(event.timestamp).toLocaleTimeString()} — {event.room_id ?? "unknown room"}: {event.decision} · score {event.motion_score?.toFixed(2) ?? "—"} · excess {event.motion_excess?.toFixed(2) ?? "—"} · {event.packet_rate ?? "?"} pkt/s
          </li>
        ))}
      </ol>
    </main>
  );
}
