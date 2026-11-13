import type { AgentTelemetry, IndexerEvent, LeaderboardRow, MarketDetail, MarketSummary } from '@delphi/shared';
export type { AgentTelemetry, IndexerEvent, LeaderboardRow, MarketDetail, MarketSummary };

export const STAGES = ['scan', 'buy', 'aggregate', 'decide', 'approve', 'trade', 'skip', 'error'] as const;
export const KINDS = ['forecast_posted', 'purchase_recorded', 'market_resolved', 'forecast_scored', 'usdc_transfer'] as const;
export const object = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
export const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
export const text = (x: unknown): x is string => typeof x === 'string';
const nullable = (x: unknown) => x === null || finite(x);

export function isEvent(x: unknown): x is IndexerEvent {
  return object(x) && finite(x.id) && finite(x.slot) && finite(x.ts) && text(x.signature) && text(x.kind) && (KINDS as readonly string[]).includes(x.kind) && object(x.data);
}
export function isTelemetry(x: unknown): x is AgentTelemetry {
  return object(x) && finite(x.ts) && text(x.stage) && (STAGES as readonly string[]).includes(x.stage) && object(x.detail) && (x.instrumentSymbol === undefined || text(x.instrumentSymbol));
}
export function isRow(x: unknown): x is LeaderboardRow {
  return object(x) && ['forecasterPda', 'authority', 'name'].every(k => text(x[k])) && ['reputationBps', 'scoredCount', 'totalReads', 'earnedUsdc'].every(k => finite(x[k]));
}
export function isMarket(x: unknown): x is MarketSummary {
  return object(x) && text(x.instrumentSymbol) && text(x.marketPda) && typeof x.resolved === 'boolean' && object(x.quote) && ['bestBid', 'bestAsk', 'lastTradePrice', 'mid'].every(k => nullable((x.quote as Record<string, unknown>)[k])) && finite(x.forecasts) && finite(x.revealed) && finite(x.reads);
}
export function isDetail(x: unknown): x is MarketDetail {
  return isMarket(x) && Array.isArray((x as MarketDetail).prices) && Array.isArray((x as MarketDetail).forecastList);
}

export async function get<T>(path: string, guard: (x: unknown) => x is T, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/${path}`, { signal, headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!response.ok) throw new Error(`Indexer request failed (HTTP ${response.status}).`);
  const value: unknown = await response.json();
  if (!guard(value)) throw new Error('Indexer returned an incompatible response.');
  return value;
}
export const list = <T,>(guard: (x: unknown) => x is T) => (x: unknown): x is T[] => Array.isArray(x) && x.every(guard);

export const timeValue = (ts: number) => (ts < 1e12 ? ts * 1000 : ts);
export const cents = (p: number | null | undefined) => (finite(p) ? `${(p * 100).toFixed(p * 100 < 10 ? 1 : 0)}¢` : '—');
export const pct = (p: number) => `${(p * 100).toFixed(2)}%`;
export const short = (s: string) => (s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);
export const txHref = (sig: string) => `https://explorer.solana.com/tx/${encodeURIComponent(sig)}?cluster=devnet`;
export const addrHref = (addr: string) => `https://explorer.solana.com/address/${encodeURIComponent(addr)}?cluster=devnet`;
export const marketHref = (symbol: string) => `#/market/${encodeURIComponent(symbol)}`;
export function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - timeValue(ts)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}
export function until(iso: string | null): string {
  const ms = Date.parse(iso ?? '') - Date.now();
  if (!Number.isFinite(ms)) return 'no expiry';
  if (ms <= 0) return 'expired';
  const m = Math.floor(ms / 60000);
  return m < 60 ? `${m}m left` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${Math.floor(m / 1440)}d left`;
}
export const clock = (ts: number) => new Date(timeValue(ts)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const symbolOf = (item: IndexerEvent | AgentTelemetry): string | undefined => {
  const v = 'data' in item ? item.data.instrumentSymbol : item.instrumentSymbol;
  return text(v) && v.length > 0 ? v : undefined;
};
