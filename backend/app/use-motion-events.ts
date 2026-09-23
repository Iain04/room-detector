"use client";

import { useCallback, useEffect, useState } from "react";

/** The shared device/backend/dashboard event contract. */
export type MotionEvent = {
  device_id: string;
  timestamp: string;
  motion_detected: boolean;
  confidence: number;
  raw_metric?: number;
};

const POLL_INTERVAL_MS = 2_000;

export function useMotionEvents() {
  const [events, setEvents] = useState<MotionEvent[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [now, setNow] = useState(0);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/motion-events?limit=500", {
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw new Error(`Could not load room activity (${response.status})`);
      const data: MotionEvent[] = await response.json();
      setEvents(data);
      setError("");
      setLastUpdated(new Date());
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "Could not load room activity");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setNow(Date.now());
    const controller = new AbortController();
    void refresh(controller.signal);
    const poll = window.setInterval(() => void refresh(controller.signal), POLL_INTERVAL_MS);
    const clock = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => {
      controller.abort();
      window.clearInterval(poll);
      window.clearInterval(clock);
    };
  }, [refresh]);

  return { events, error, loading, lastUpdated, now, refresh: () => refresh() };
}
