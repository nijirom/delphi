import type { AgentTelemetry, IndexerEvent, LeaderboardRow } from "@delphi/shared";

export type { AgentTelemetry, IndexerEvent, LeaderboardRow };
export type EventKind = IndexerEvent["kind"];
export type Stage = AgentTelemetry["stage"];

export const EVENT_KINDS: EventKind[] = [
  "forecast_posted",
  "purchase_recorded",
  "market_resolved",
  "forecast_scored",
  "usdc_transfer",
];

/** Indexer `data` payloads (confirmed with services/indexer). Enrichment fields are optional
 *  only when the indexer's account fetch failed. Amounts are USDC base units (6 dp). */
export type EventData = {
  forecast_posted: { forecaster: string; market: string; commitment: string; instrumentSymbol?: string; forecasterName?: string };
  purchase_recorded: { forecast: string; buyer: string; amount: number; paymentSig: string; forecaster?: string; instrumentSymbol?: string; forecasterName?: string };
  market_resolved: { market: string; outcomeYes: boolean; instrumentSymbol?: string };
  forecast_scored: { forecast: string; forecaster: string; probBps: number; brierBps: number; reputationBps: number; instrumentSymbol?: string; forecasterName?: string };
  usdc_transfer: { from: string | null; to: string; ata: string; amount: number; forecaster?: string; forecasterName?: string };
};
export type TypedEvent<K extends EventKind = EventKind> = Omit<IndexerEvent, "kind" | "data"> & { kind: K; data: EventData[K] };

export function isKind<K extends EventKind>(e: IndexerEvent, kind: K): e is TypedEvent<K> {
  return e.kind === kind;
}

/** Keys the buyer agent puts in `detail` for stage `decide`. */
export type Decision = { pooled: number; market: number; side: "yes" | "no"; edge: number; threshold?: number; sizeUsdc?: number };

async function get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
  const res = await fetch(`/api${path}${qs.size ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export const fetchLeaderboard = () => get<LeaderboardRow[]>("/leaderboard");
export const fetchEvents = (q: { kind?: EventKind | ""; limit?: number; since?: number } = {}) =>
  get<IndexerEvent[]>("/events", q);
export const fetchTelemetry = (limit = 200) => get<AgentTelemetry[]>("/telemetry", { limit });

export type StreamHandlers = {
  onEvent: (e: IndexerEvent) => void;
  onTelemetry: (t: AgentTelemetry) => void;
  onStatus?: (live: boolean) => void;
};

/** Subscribe to `GET /stream` SSE: named messages `event` and `telemetry` carrying JSON. Returns unsubscribe. */
export function subscribe(h: StreamHandlers): () => void {
  const es = new EventSource("/api/stream");
  es.addEventListener("event", (m) => h.onEvent(JSON.parse((m as MessageEvent<string>).data) as IndexerEvent));
  es.addEventListener("telemetry", (m) => h.onTelemetry(JSON.parse((m as MessageEvent<string>).data) as AgentTelemetry));
  es.onopen = () => h.onStatus?.(true);
  es.onerror = () => h.onStatus?.(false);
  return () => es.close();
}

/** Instrument symbol attached to an event, if the indexer could resolve it. */
export function symbolOf(e: IndexerEvent): string | undefined {
  const s = e.data.instrumentSymbol;
  return typeof s === "string" && s ? s : undefined;
}

export const txUrl = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const addrUrl = (addr: string) => `https://explorer.solana.com/address/${addr}?cluster=devnet`;
export const short = (s: string) => (s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);
export const fmtUsdc = (v: number) => `$${v.toFixed(v > 0 && v < 0.01 ? 4 : 2)}`;
export const fmtTime = (ts: number) => new Date(ts > 1e12 ? ts : ts * 1000).toLocaleTimeString([], { hour12: false });
