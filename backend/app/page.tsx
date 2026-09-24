"use client";

import { useEffect, useMemo, useState } from "react";
import { useMotionEvents } from "./use-motion-events";
import type { MotionEvent } from "./use-motion-events";

const BLOCKS = ["55", "57", "59"] as const;
// Temporary sensor visualisation. Set false (or remove SensorDebugChart) once testing is complete.
const DEBUG_SENSOR_CHART = true;
const EMPTY_ROOM_REFERENCE = 0.4115;
const MOTION_TOLERANCE = 0.0515;
const VACANT_LOWER_BOUND = EMPTY_ROOM_REFERENCE - MOTION_TOLERANCE;
const VACANT_UPPER_BOUND = EMPTY_ROOM_REFERENCE + MOTION_TOLERANCE;
const ROOM_SPECS = [
  { name: "Level 2 Meeting Room", type: "Meeting room", floor: 2, seed: 34 },
  { name: "Level 2 Study Room", type: "Study room", floor: 2, seed: 18 },
  { name: "Level 4 Recreational Room", type: "Recreational room", floor: 4, seed: 57 },
  { name: "Level 4 Meeting Room", type: "Meeting room", floor: 4, seed: 9 },
  { name: "Level 6 Study Room", type: "Study room", floor: 6, seed: 72 },
  { name: "Level 6 Meeting Room", type: "Meeting room", floor: 6, seed: 26 },
] as const;

type DisplayStatus = "Motion detected" | "No motion" | "Calibrating…" | "Signal unreliable";
type OccupancyFilter = "All rooms" | "Vacant" | "Occupied";
type BlockFilter = "All blocks" | (typeof BLOCKS)[number];
type RoomCardModel = {
  key: string;
  room: string;
  block: string;
  roomType: string;
  status: DisplayStatus;
  timestamp: string;
};

function Icon({ name, size = 18 }: { name: "search" | "building" | "clock"; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true as const };
  if (name === "search") return <svg {...common}><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/></svg>;
  if (name === "building") return <svg {...common}><path d="M4 21h16M6 21V5l6-2 6 2v16M9 8h.01M15 8h.01M9 12h.01M15 12h.01M10 21v-5h4v5"/></svg>;
  return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M12 8v4l2.5 2.5"/></svg>;
}

function roomKey(block: string, floor: number, type: string) {
  return `${block}|${floor}|${type.toLowerCase()}`;
}

function formatRoomId(roomId?: string) {
  if (!roomId) return null;
  const normalized = roomId.toLowerCase().replace(/_/g, "-");
  const block = normalized.match(/(?:^|-)(?:blk|block)-?(55|57|59)(?:-|$)/)?.[1];
  const floor = normalized.match(/(?:^|-)(?:level|lvl)-?(\d+)(?:-|$)/)?.[1]
    ?? normalized.match(/(?:room|study|meeting|recreational)-?(\d+)$/)?.[1];
  const type = normalized.includes("recreational") ? "Recreational room"
    : normalized.includes("meeting") ? "Meeting room"
      : normalized.includes("study") ? "Study room"
        : normalized.includes("conference") ? "Conference room"
          : normalized.includes("office") ? "Office"
            : null;
  if (!type || !floor) return null;
  return { block, floor: Number(floor), type };
}

function roomDisplayName(roomId: string, roomType: string, floor: number) {
  const kind = roomType.replace(/\s+room$/i, "");
  return `Level ${floor} ${kind} Room`;
}

function getStatus(event: MotionEvent): DisplayStatus {
  if (event.decision === "warming_up") return "Calibrating…";
  if (event.decision === "ignored") return "Signal unreliable";
  return event.motion_detected ? "Motion detected" : "No motion";
}

function statusClass(status: DisplayStatus) {
  if (status === "Motion detected") return "motion";
  if (status === "No motion") return "clear";
  if (status === "Calibrating…") return "calibrating";
  return "unreliable";
}

function localTime(timestamp: string) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function createFakeRoom(block: string, spec: (typeof ROOM_SPECS)[number], roomIndex: number, blockIndex: number, now: number): RoomCardModel {
  const occupied = (roomIndex + blockIndex) % 3 === 1;
  const changedAt = new Date(now - (spec.seed + blockIndex * 7) * 60_000).toISOString();
  return {
    key: roomKey(block, spec.floor, spec.type),
    room: spec.name,
    block,
    roomType: spec.type,
    status: occupied ? "Motion detected" : "No motion",
    timestamp: localTime(changedAt),
  };
}

function createLiveRoom(event: MotionEvent, location: { block?: string; floor: number; type: string }, block: string): RoomCardModel {
  return {
    key: roomKey(block, location.floor, location.type),
    room: roomDisplayName(event.room_id ?? "", location.type, location.floor),
    block,
    roomType: location.type,
    status: getStatus(event),
    timestamp: localTime(event.timestamp),
  };
}

function StatusPill({ status }: { status: DisplayStatus }) {
  return <span className={`browse-status ${statusClass(status)}`}><i/>{status === "Motion detected" ? "Occupied" : status === "No motion" ? "Vacant" : status}</span>;
}

function RoomCard({ room }: { room: RoomCardModel }) {
  const occupied = room.status === "Motion detected";
  const vacant = room.status === "No motion";
  const sinceLabel = occupied ? "Occupied since" : vacant ? "Vacant since" : "Status updated";
  return <article className={`browse-room-card ${occupied ? "room-is-occupied" : vacant ? "room-is-vacant" : "room-state-pending"}`}>
    <div className="browse-card-top"><span className="browse-block"><Icon name="building" size={14}/>Block {room.block}</span><StatusPill status={room.status}/></div>
    <h3>{room.room}</h3>
    <span className="browse-room-type">{room.roomType}</span>
    <div className="browse-state-time"><span>{sinceLabel}</span><strong suppressHydrationWarning>{room.timestamp}</strong></div>
  </article>;
}

function SensorDebugChart({ events }: { events: MotionEvent[] }) {
  const data = [...events]
    .filter((event) => typeof event.baseline_diff === "number" && Number.isFinite(event.baseline_diff))
    .reverse()
    .slice(-60);
  if (data.length < 2) return <section className="debug-sensor-chart" aria-label="Temporary sensor signal visualisation">
    <div className="debug-sensor-heading"><div><span>TESTING ONLY</span><h2>Live baseline-difference signal</h2><p>Waiting for at least two calibrated MQTT sensor readings before drawing the chart.</p></div><strong className="debug-pending">WAITING</strong></div>
  </section>;

  const width = 760;
  const height = 190;
  const padding = { top: 20, right: 16, bottom: 28, left: 42 };
  const values = data.map((event) => event.baseline_diff!);
  const lower = Math.max(0, Math.min(...values, VACANT_LOWER_BOUND) - 0.03);
  const upper = Math.max(...values, VACANT_UPPER_BOUND) + 0.03;
  const x = (index: number) => padding.left + index * (width - padding.left - padding.right) / (data.length - 1);
  const y = (value: number) => padding.top + (upper - value) * (height - padding.top - padding.bottom) / (upper - lower);
  const line = data.map((event, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(event.baseline_diff!).toFixed(1)}`).join(" ");
  const latest = data.at(-1)!;

  return <section className="debug-sensor-chart" aria-label="Temporary sensor signal visualisation">
    <div className="debug-sensor-heading"><div><span>TESTING ONLY</span><h2>Live baseline-difference signal</h2><p>Green band = vacant. Crossing outside either red threshold = occupied.</p></div><strong className={latest.motion_detected ? "debug-motion" : "debug-clear"}>{latest.motion_detected ? "MOTION" : "CLEAR"}</strong></div>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Baseline difference over recent sensor readings">
      <rect x={padding.left} y={y(VACANT_UPPER_BOUND)} width={width - padding.left - padding.right} height={y(VACANT_LOWER_BOUND) - y(VACANT_UPPER_BOUND)} className="debug-band"/>
      {[lower, (lower + upper) / 2, upper].map((value) => <g key={value}><line x1={padding.left} x2={width - padding.right} y1={y(value)} y2={y(value)} className="debug-grid"/><text x={padding.left - 7} y={y(value) + 3} textAnchor="end">{value.toFixed(2)}</text></g>)}
      {[VACANT_LOWER_BOUND, VACANT_UPPER_BOUND].map((value) => <g key={value}><line x1={padding.left} x2={width - padding.right} y1={y(value)} y2={y(value)} className="debug-threshold"/><text x={width - padding.right} y={y(value) - 4} textAnchor="end" className="debug-threshold-label">{value.toFixed(3)} threshold</text></g>)}
      <line x1={padding.left} x2={width - padding.right} y1={y(EMPTY_ROOM_REFERENCE)} y2={y(EMPTY_ROOM_REFERENCE)} className="debug-reference"/>
      <path d={line} className="debug-line"/>
      <circle cx={x(data.length - 1)} cy={y(latest.baseline_diff!)} r="4" className={latest.motion_detected ? "debug-dot-motion" : "debug-dot-clear"}/>
      <text x={padding.left} y={height - 8}>oldest</text><text x={width - padding.right} y={height - 8} textAnchor="end">latest</text>
    </svg>
  </section>;
}

export default function Home() {
  const { events, error, lastUpdated, now } = useMotionEvents();
  const [query, setQuery] = useState("");
  const [occupancy, setOccupancy] = useState<OccupancyFilter>("All rooms");
  const [block, setBlock] = useState<BlockFilter>("All blocks");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [sampleNow, setSampleNow] = useState(0);
  useEffect(() => setSampleNow(Date.now()), []);
  useEffect(() => {
    try {
      if (window.localStorage.getItem("gotroom-theme") === "dark") setTheme("dark");
    } catch {
      // The switch still works for this visit if browser storage is unavailable.
    }
  }, []);

  function toggleTheme() {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    try {
      window.localStorage.setItem("gotroom-theme", nextTheme);
    } catch {
      // Keep the selected theme for this visit if browser storage is unavailable.
    }
  }

  const liveByRoom = useMemo(() => {
    const matched = new Map<string, MotionEvent>();
    for (const event of [...events].reverse()) {
      const location = formatRoomId(event.room_id);
      if (!location) continue;
      // Older room IDs often omit their block; use Block 55 as the single live target.
      const liveBlock = location.block ?? "55";
      const key = roomKey(liveBlock, location.floor, location.type);
      // Once a sensor has produced a stable decision, do not replace the room
      // card with a later warming_up/ignored event after a backend restart.
      const isStable = event.decision === "present" || event.decision === "clear";
      if (isStable || !matched.has(key)) matched.set(key, event);
    }
    return matched;
  }, [events]);

  const rooms = useMemo(() => {
    const samples = BLOCKS.flatMap((blockId, blockIndex) => ROOM_SPECS.map((spec, roomIndex) => createFakeRoom(blockId, spec, roomIndex, blockIndex, sampleNow)));
    return samples.map((sample) => {
      const liveEvent = liveByRoom.get(sample.key);
      if (!liveEvent) return sample;
      const location = formatRoomId(liveEvent.room_id)!;
      return createLiveRoom(liveEvent, location, sample.block);
    }).sort((a, b) => a.block.localeCompare(b.block) || a.room.localeCompare(b.room));
  }, [sampleNow, liveByRoom]);

  const counts = useMemo(() => rooms.reduce((result, room) => {
    if (room.status === "Motion detected") result.Occupied += 1;
    else if (room.status === "No motion") result.Vacant += 1;
    return result;
  }, { Vacant: 0, Occupied: 0 }), [rooms]);
  const visibleRooms = rooms.filter((room) => {
    const isOccupied = room.status === "Motion detected";
    const isVacant = room.status === "No motion";
    const matchesOccupancy = occupancy === "All rooms" || (occupancy === "Occupied" ? isOccupied : isVacant);
    const matchesBlock = block === "All blocks" || room.block === block;
    const matchesQuery = `${room.room} ${room.roomType} ${room.block}`.toLowerCase().includes(query.trim().toLowerCase());
    return matchesOccupancy && matchesBlock && matchesQuery;
  });
  const currentEvent = events[0];
  const filters: OccupancyFilter[] = ["All rooms", "Vacant", "Occupied"];

  return <main className="customer-shell" data-theme={theme}>
    <header className="customer-header"><a className="customer-brand" href="#top"><img className="gotroom-brand-mark" src={theme === "dark" ? "/gotroom-mark-dark.png" : "/gotroom-mark-light.png"} alt="" aria-hidden="true"/><span>got room<span className="brand-question">?</span></span></a><div className="customer-header-right"><span className="customer-live"><i/>LIVE UPDATES</span><span className="customer-date">{now ? new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric" }).format(now) : ""}</span><button type="button" className="theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>{theme === "dark" ? <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.2 15.4A8.5 8.5 0 0 1 8.6 3.8 8.7 8.7 0 1 0 20.2 15.4Z"/></svg>}</button></div></header>
    <section className="customer-main connection-main" id="top">
      <div className="customer-heading"><div><div className="eyebrow">ROOM AVAILABILITY</div><h1>Find a room<span>.</span></h1><p>Search by room name, floor, or block to find an available space.</p></div><div className="customer-sync"><span className="sync-check"><i/></span><span>{lastUpdated && now ? `Synced ${new Date(lastUpdated).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Updating room data…"}</span></div></div>
      {error && <div className="error-banner" role="alert">Live sensor updates are unavailable. Sample occupancy remains visible.</div>}
      {DEBUG_SENSOR_CHART && <SensorDebugChart events={events}/>}

      <section className="customer-rooms-section"><div className="customer-section-heading"><div><h2>Browse rooms <span className="room-total">{visibleRooms.length}</span></h2><p>Live sensor rooms update automatically; remaining rooms show sample occupancy.</p></div></div>
        <label className="room-search room-search-featured"><Icon name="search" size={19}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search rooms by name or floor…" aria-label="Search rooms by name or floor"/></label>
        <div className="room-toolbar"><div className="room-filters" role="group" aria-label="Filter rooms by occupancy">{filters.map((item) => <button key={item} className={occupancy === item ? `selected ${item.toLowerCase().replace(" ", "-")}` : ""} onClick={() => setOccupancy(item)} aria-pressed={occupancy === item}>{item}<span>{item === "All rooms" ? rooms.length : counts[item]}</span></button>)}</div><label className="block-filter"><span>Block</span><select aria-label="Filter by block" value={block} onChange={(event) => setBlock(event.target.value as BlockFilter)}>{(["All blocks", ...BLOCKS] as BlockFilter[]).map((item) => <option key={item} value={item}>{item === "All blocks" ? item : `Block ${item}`}</option>)}</select></label></div>
        {visibleRooms.length ? <div className="customer-room-grid">{visibleRooms.map((room) => <RoomCard key={room.key} room={room}/>)}</div> : <div className="customer-empty"><span className="empty-event-icon"><Icon name="building"/></span><strong>No rooms match that search</strong><span>Try another room name, floor, block, or occupancy filter.</span></div>}
      </section>
      {currentEvent && <p className="latest-event-note">Latest backend event: {currentEvent.device_id} · {localTime(currentEvent.timestamp)}</p>}
      <footer className="customer-footer"><span>got room? <i>·</i> Camera-free room sensing</span><span>Times shown in your local timezone</span></footer>
    </section>
  </main>;
}
