"use client";

import { useEffect, useMemo, useState } from "react";
import { useMotionEvents } from "./use-motion-events";
import type { MotionEvent } from "./use-motion-events";

const BLOCKS = ["55", "57", "59"] as const;
const ROOM_TYPES = ["Meeting room", "Study room", "Recreational room"] as const;
const ROOM_NAMES = [
  { name: "Level 2 Meeting Room", type: "Meeting room", vacantMinutes: 34 },
  { name: "Level 2 Study Room", type: "Study room", vacantMinutes: 18 },
  { name: "Level 4 Recreational Room", type: "Recreational room", vacantMinutes: 57 },
  { name: "Level 4 Meeting Room", type: "Meeting room", vacantMinutes: 9 },
  { name: "Level 6 Study Room", type: "Study room", vacantMinutes: 72 },
  { name: "Level 6 Meeting Room", type: "Meeting room", vacantMinutes: 26 },
] as const;

type OccupancyFilter = "All rooms" | "Vacant" | "Occupied";
type BlockFilter = "All blocks" | (typeof BLOCKS)[number];
type Room = {
  id: string;
  name: string;
  type: string;
  block: string;
  occupied: boolean;
  stateSince: string;
  lastUpdated: string;
  isDemo: boolean;
  isCalibrating: boolean;
};

function Icon({ name, size = 18 }: { name: "search" | "building" | "clock"; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true as const };
  if (name === "search") return <svg {...common}><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/></svg>;
  if (name === "building") return <svg {...common}><path d="M4 21h16M6 21V5l6-2 6 2v16M9 8h.01M15 8h.01M9 12h.01M15 12h.01M10 21v-5h4v5"/></svg>;
  return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M12 8v4l2.5 2.5"/></svg>;
}

function roomId(block: string, name: string) {
  return `demo-${block}-${name.toLowerCase().replace(/\s+/g, "-")}`;
}

function makeDemoEvents(now: number): MotionEvent[] {
  return BLOCKS.flatMap((block, blockIndex) => ROOM_NAMES.flatMap((room, roomIndex) => {
    const id = roomId(block, room.name);
    const occupied = (roomIndex + blockIndex) % 3 === 1;
    const sinceMinutes = room.vacantMinutes + blockIndex * 7;
    const changedAt = new Date(now - sinceMinutes * 60_000).toISOString();
    return [
      { device_id: id, timestamp: new Date(now - 2 * 60_000).toISOString(), motion_detected: occupied, confidence: 0.94, decision: occupied ? "present" : "clear" },
      { device_id: id, timestamp: changedAt, motion_detected: occupied, confidence: 0.93, decision: occupied ? "present" : "clear" },
      { device_id: id, timestamp: new Date(now - (sinceMinutes + 4) * 60_000).toISOString(), motion_detected: !occupied, confidence: 0.89, decision: occupied ? "clear" : "present" },
    ];
  }));
}

function titleCase(value: string) {
  return value.replace(/^demo-(55|57|59)-/, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function timeAgo(timestamp: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1_000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function localTime(timestamp: string) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function durationSince(timestamp: string, now: number) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 60_000));
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours < 24 ? `${hours}h ${rest}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function buildRooms(events: MotionEvent[]): Room[] {
  const groups = new Map<string, MotionEvent[]>();
  for (const event of events) groups.set(event.device_id, [...(groups.get(event.device_id) ?? []), event]);
  const demoDirectory = new Map(BLOCKS.flatMap((block) => ROOM_NAMES.map((room) => [roomId(block, room.name), { block, room }] as const)));

  return [...groups.entries()].map(([id, readings]) => {
    const ordered = [...readings].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const latest = ordered[ordered.length - 1];
    const conclusive = ordered.filter((event) => event.decision === undefined || event.decision === "present" || event.decision === "clear");
    const latestDecision = conclusive[conclusive.length - 1];
    let stateSince = latestDecision?.timestamp ?? latest.timestamp;
    for (let index = 1; index < conclusive.length; index += 1) {
      if (conclusive[index].motion_detected !== conclusive[index - 1].motion_detected) stateSince = conclusive[index].timestamp;
    }
    const demo = demoDirectory.get(id);
    return {
      id,
      name: demo?.room.name ?? titleCase(id),
      type: demo?.room.type ?? "Room",
      block: demo?.block ?? "Unassigned",
      occupied: (latestDecision ?? latest).decision === "present" || ((latestDecision ?? latest).decision === undefined && (latestDecision ?? latest).motion_detected),
      stateSince,
      lastUpdated: latest.timestamp,
      isDemo: Boolean(demo),
      isCalibrating: !latestDecision || latest.decision === "warming_up" || latest.decision === "ignored",
    };
  }).sort((a, b) => Number(a.occupied) - Number(b.occupied) || a.block.localeCompare(b.block) || a.name.localeCompare(b.name));
}

function RoomCard({ room, now }: { room: Room; now: number }) {
  return <article className={`browse-room-card ${room.occupied ? "room-is-occupied" : "room-is-vacant"}`}>
    <div className="browse-card-top"><span className="browse-block"><Icon name="building" size={14}/>Block {room.block}</span><span className={`browse-status ${room.isCalibrating ? "status-calibrating" : room.occupied ? "status-occupied" : "status-vacant"}`}><i/>{room.isCalibrating ? "Calibrating" : room.occupied ? "Occupied" : "Vacant"}</span></div>
    <h3>{room.name}</h3>
    <span className="browse-room-type">{room.type}</span>
    <div className="browse-state-time"><span>{room.isCalibrating ? "Occupancy status" : room.occupied ? "Occupied since" : "Vacant since"}</span><strong>{room.isCalibrating ? "Checking" : localTime(room.stateSince)}</strong></div>
    <div className="browse-room-bottom"><span>{room.isDemo ? "Sample room" : room.isCalibrating ? "Sensor checking" : "Room sensor"}</span><span>Last updated {timeAgo(room.lastUpdated, now)}</span></div>
  </article>;
}

export default function Home() {
  const { events, error, lastUpdated, now } = useMotionEvents();
  const [demoEvents, setDemoEvents] = useState<MotionEvent[]>([]);
  const [query, setQuery] = useState("");
  const [occupancy, setOccupancy] = useState<OccupancyFilter>("All rooms");
  const [block, setBlock] = useState<BlockFilter>("All blocks");
  useEffect(() => setDemoEvents(makeDemoEvents(Date.now())), []);
  const rooms = useMemo(() => buildRooms([...events, ...demoEvents]), [events, demoEvents]);
  const counts = useMemo(() => rooms.reduce((result, room) => {
    if (!room.isCalibrating) result[room.occupied ? "Occupied" : "Vacant"] += 1;
    return result;
  }, { Vacant: 0, Occupied: 0 }), [rooms]);
  const visibleRooms = rooms.filter((room) => {
    const matchesOccupancy = occupancy === "All rooms" || (!room.isCalibrating && (occupancy === "Occupied") === room.occupied);
    const matchesBlock = block === "All blocks" || room.block === block;
    const matchesQuery = `${room.name} ${room.type} ${room.block}`.toLowerCase().includes(query.toLowerCase());
    return matchesOccupancy && matchesBlock && matchesQuery;
  });
  const filters: OccupancyFilter[] = ["All rooms", "Vacant", "Occupied"];

  return <main className="customer-shell">
    <header className="customer-header"><a className="customer-brand" href="#top"><span className="brand-mark"><span/><span/><span/><span/></span><span>roomwise</span></a><div className="customer-header-right"><span className="customer-live"><i/>DEMO DATA</span><span className="customer-date">{now ? new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric" }).format(now) : ""}</span></div></header>
    <section className="customer-main" id="top">
      <div className="customer-heading"><div><div className="eyebrow">ROOM AVAILABILITY</div><h1>Find a room<span>.</span></h1><p>Search by room name, floor, or block to find an available space.</p></div><div className="customer-sync"><span className="sync-check"><i/></span><span>{lastUpdated ? `Room data updated ${timeAgo(lastUpdated.toISOString(), now)}` : "Connecting to room sensors…"}</span></div></div>
      {error && <div className="error-banner" role="alert">Live sensor updates are unavailable. Showing sample room data.</div>}

      <section className="customer-rooms-section"><div className="customer-section-heading"><div><h2>Browse rooms <span className="room-total">{visibleRooms.length}</span></h2><p>Vacancy time and the latest room update.</p></div></div>
        <label className="room-search room-search-featured"><Icon name="search" size={19}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search rooms by name or floor…" aria-label="Search rooms by name or floor"/></label>
        <div className="room-toolbar"><div className="room-filters" role="group" aria-label="Filter rooms by occupancy">{filters.map((item) => <button key={item} className={occupancy === item ? `selected ${item.toLowerCase().replace(" ", "-")}` : ""} onClick={() => setOccupancy(item)} aria-pressed={occupancy === item}>{item}<span>{item === "All rooms" ? rooms.length : counts[item]}</span></button>)}</div><label className="block-filter"><span>Block</span><select aria-label="Filter by block" value={block} onChange={(event) => setBlock(event.target.value as BlockFilter)}>{(["All blocks", ...BLOCKS] as BlockFilter[]).map((item) => <option key={item} value={item}>{item === "All blocks" ? item : `Block ${item}`}</option>)}</select></label></div>
        {visibleRooms.length ? <div className="customer-room-grid">{visibleRooms.map((room) => <RoomCard key={room.id} room={room} now={now}/>)}</div> : <div className="customer-empty"><span className="empty-event-icon"><Icon name="building"/></span><strong>No rooms match that search</strong><span>Try a different room name, floor, block, or occupancy filter.</span></div>}
      </section>
      <footer className="customer-footer"><span>Roomwise <i>·</i> Private, camera-free room sensing</span><span>Times shown in your local timezone</span></footer>
    </section>
  </main>;
}
