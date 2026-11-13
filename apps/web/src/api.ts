import type { AgentTelemetry, IndexerEvent, LeaderboardRow, MarketDetail, MarketSummary } from '@delphi/shared';
export type { AgentTelemetry, IndexerEvent, LeaderboardRow, MarketDetail, MarketSummary };

export const STAGES = ['scan', 'buy', 'aggregate', 'decide', 'approve', 'trade', 'skip', 'error'] as const;
export const KINDS = ['forecast_posted', 'purchase_recorded', 'market_resolved', 'forecast_scored', 'usdc_transfer'] as const;
export const object = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
export const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
export const text = (x: unknown): x is string => typeof x === 'string';
const probability = (x: unknown): x is number => finite(x) && x >= 0 && x <= 1;
const nullablePrice = (x: unknown): x is number | null => x === null || probability(x);
const count = (x: unknown): x is number => finite(x) && Number.isSafeInteger(x) && x >= 0;
const nullableTime = (x: unknown): x is number | null => x === null || count(x);

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
  if (!object(x) || !text(x.instrumentSymbol) || !text(x.marketPda) || typeof x.resolved !== 'boolean' || !object(x.quote)) return false;
  const quote = x.quote;
  return ['bestBid', 'bestAsk', 'lastTradePrice', 'mid'].every(k => nullablePrice(quote[k]))
    && ['eventTicker', 'title', 'category', 'expiryDate', 'geminiStatus'].every(k => x[k] === null || text(x[k]))
    && (x.outcomeYes === null || typeof x.outcomeYes === 'boolean') && nullableTime(x.resolvedAt) && nullableTime(x.quoteUpdatedAt)
    && count(x.forecasts) && count(x.revealed) && count(x.reads) && (x.latestDecision === null || isTelemetry(x.latestDecision));
}
export function isDetail(x: unknown): x is MarketDetail {
  if (!isMarket(x)) return false;
  const detail = x as Record<string, unknown>;
  return Array.isArray(detail.prices) && detail.prices.every(p => object(p) && count(p.ts) && nullablePrice(p.bid) && nullablePrice(p.ask) && nullablePrice(p.mid))
    && Array.isArray(detail.forecastList) && detail.forecastList.every((f: unknown) => object(f)
      && ['forecastPda', 'forecasterPda', 'forecasterName'].every(k => text(f[k]))
      && count(f.reputationBps) && f.reputationBps <= 10000 && finite(f.pricePerReadUsdc) && f.pricePerReadUsdc >= 0
      && count(f.reads) && count(f.postedAt) && typeof f.revealed === 'boolean'
      && (f.revealed ? count(f.probBps) && f.probBps <= 10000 && count(f.brierBps) && f.brierBps <= 10000 : f.probBps === null && f.brierBps === null));
}

export function isHealth(x: unknown): x is { ok: boolean; snapshotAt: number | null } {
  return object(x) && typeof x.ok === 'boolean' && nullableTime(x.snapshotAt);
}

export async function get<T>(path: string, guard: (x: unknown) => x is T, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(12000);
  try {
    const response = await fetch(`/api/${path}`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) throw new Error(`Indexer request failed (HTTP ${response.status}).`);
    const value: unknown = await response.json();
    if (!guard(value)) throw new Error('Indexer returned an incompatible response.');
    return value;
  } catch (error) {
    if (timeout.aborted && !signal?.aborted) throw new Error('Indexer request timed out.');
    throw error;
  }
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
