import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentTelemetry, IndexerEvent, LeaderboardRow } from '@delphi/shared';
import './style.css';

type Snapshot = { leaderboard: LeaderboardRow[]; events: IndexerEvent[]; telemetry: AgentTelemetry[] };
type Route = { page: 'leaderboard' | 'feed' | 'market' | 'missing'; symbol?: string };
const stages = new Set(['scan', 'buy', 'aggregate', 'decide', 'approve', 'trade', 'skip', 'error']);
const kinds = new Set(['forecast_posted', 'purchase_recorded', 'market_resolved', 'forecast_scored', 'usdc_transfer']);
const object = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const text = (x: unknown): x is string => typeof x === 'string';
function isEvent(x: unknown): x is IndexerEvent {
  return object(x) && finite(x.id) && finite(x.slot) && finite(x.ts) && text(x.signature) && text(x.kind) && kinds.has(x.kind) && object(x.data);
}
function isTelemetry(x: unknown): x is AgentTelemetry {
  return object(x) && finite(x.ts) && text(x.stage) && stages.has(x.stage) && object(x.detail) && (x.instrumentSymbol === undefined || text(x.instrumentSymbol));
}
function isRow(x: unknown): x is LeaderboardRow {
  return object(x) && ['forecasterPda', 'authority', 'name'].every(k => text(x[k])) && ['reputationBps', 'scoredCount', 'totalReads', 'earnedUsdc'].every(k => finite(x[k]));
}
async function getList<T>(path: string, guard: (x: unknown) => x is T, signal: AbortSignal): Promise<T[]> {
  const response = await fetch(`/api/${path}`, { signal, headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!response.ok) throw new Error(`Indexer request failed (HTTP ${response.status}).`);
  const value: unknown = await response.json();
  if (!Array.isArray(value) || !value.every(guard)) throw new Error('Indexer returned an incompatible response. Check the indexer version.');
  return value;
}
function route(): Route {
  const hash = window.location.hash || '#/';
  if (hash === '#/' || hash === '#') return { page: 'leaderboard' };
  if (hash === '#/feed') return { page: 'feed' };
  if (hash.startsWith('#/market/')) {
    try { const symbol = decodeURIComponent(hash.slice('#/market/'.length)); if (symbol && symbol.length <= 64) return { page: 'market', symbol }; } catch { /* Invalid routes render the not-found view. */ }
  }
  return { page: 'missing' };
}
const marketHref = (symbol: string) => `#/market/${encodeURIComponent(symbol)}`;
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const usdc = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const pct = (n: number) => `${number.format(n * 100)}%`;
function date(ts: number) { const d = new Date(ts < 1e12 ? ts * 1000 : ts); return Number.isNaN(d.valueOf()) ? 'Unknown time' : d.toLocaleString(); }
function symbolOf(item: IndexerEvent | AgentTelemetry): string | undefined {
  const value = 'data' in item ? item.data.instrumentSymbol : item.instrumentSymbol ?? item.detail.instrumentSymbol;
  return text(value) && value.length > 0 ? value : undefined;
}
function timeValue(ts: number) { return ts < 1e12 ? ts * 1000 : ts; }
function txHref(signature: string) { return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`; }
function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="empty"><span className="empty-mark" aria-hidden="true">◇</span><h3>{title}</h3><p>{children}</p></div>;
}
function MarketLink({ symbol }: { symbol?: string }) {
  return symbol ? <a className="symbol" href={marketHref(symbol)}>{symbol} <span aria-hidden="true">↗</span></a> : <span className="muted">Market not enriched</span>;
}
function Metrics({ detail }: { detail: Record<string, unknown> }) {
  const values = [['pooled', 'Pooled forecast'], ['marketPrice', 'Market price'], ['edge', 'Edge']] as const;
  const available = values.filter(([key]) => finite(detail[key]));
  return available.length ? <dl className="metrics">{available.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{pct(detail[key] as number)}</dd></div>)}</dl> : null;
}
function ProgramCard({ item }: { item: IndexerEvent }) {
  const fields = ['amount', 'probBps', 'brierBps', 'reputationBps', 'outcomeYes'] as const;
  return <article className="activity"><div className="card-top"><span className="pill">{item.kind.replaceAll('_', ' ')}</span><time>{date(item.ts)}</time></div><MarketLink symbol={symbolOf(item)} /><dl className="event-fields">{fields.map(key => {
    const value = item.data[key];
    return finite(value) || typeof value === 'boolean' || (key === 'amount' && text(value) && /^\d+$/.test(value)) ? <div key={key}><dt>{key === 'amount' ? 'Amount (base units)' : key}</dt><dd>{String(value)}</dd></div> : null;
  })}</dl><div className="card-bottom"><span>Slot {number.format(item.slot)}</span>{/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(item.signature) ? <a href={txHref(item.signature)} target="_blank" rel="noreferrer">View transaction ↗</a> : <span>Transaction unavailable</span>}</div></article>;
}
function TelemetryCard({ item }: { item: AgentTelemetry }) {
  // Display only allowlisted operational fields; arbitrary detail may contain credentials.
  const reason = text(item.detail.reason) && /^[\w .,:;()\-]{1,180}$/.test(item.detail.reason) ? item.detail.reason : undefined;
  return <article className="activity"><div className="card-top"><span className={`pill stage-${item.stage}`}>{item.stage}</span><time>{date(item.ts)}</time></div><MarketLink symbol={symbolOf(item)} /><Metrics detail={item.detail} />{reason && <p className="reason">{reason}</p>}{finite(item.detail.size) && <p className="muted">Order size: {usdc.format(item.detail.size)} USDC</p>}</article>;
}
function Activity({ events, telemetry, market = false }: { events: IndexerEvent[]; telemetry: AgentTelemetry[]; market?: boolean }) {
  return <div className="columns"><section aria-labelledby="program-heading"><div className="section-heading"><h2 id="program-heading">Program activity</h2><span className="count">{events.length}</span></div>{events.length ? events.map(e => <ProgramCard key={`${e.signature}:${e.id}`} item={e} />) : <Empty title="No program events">{market ? 'No indexed events with this instrument symbol in the current window. Events without symbol enrichment are excluded.' : 'Posted forecasts, purchases, resolutions and scores appear here when the indexer receives them.'}</Empty>}</section><section aria-labelledby="agent-heading"><div className="section-heading"><h2 id="agent-heading">Agent telemetry</h2><span className="count">{telemetry.length}</span></div>{telemetry.length ? telemetry.map((t, i) => <TelemetryCard key={`${t.ts}:${t.stage}:${i}`} item={t} />) : <Empty title="Waiting for agent activity">Scan, purchase and decision stages appear when the buyer sends telemetry. No activity is simulated.</Empty>}</section></div>;
}
function App() {
  const [current, setCurrent] = useState<Route>(route);
  const [snapshot, setSnapshot] = useState<Snapshot>({ leaderboard: [], events: [], telemetry: [] });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [updated, setUpdated] = useState<number>();
  const [stream, setStream] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  const [filter, setFilter] = useState('');
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh(n => n + 1), []);
  const busy = useRef(false);
  useEffect(() => { const change = () => { setCurrent(route()); setFilter(''); window.scrollTo(0, 0); }; window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let inFlight = false;
    async function load() {
      if (inFlight) return;
      inFlight = true; busy.current = true;
      try {
        const [leaderboard, events, telemetry] = await Promise.all([
          getList('leaderboard', isRow, controller.signal),
          getList('events?limit=200', isEvent, controller.signal),
          getList('telemetry?limit=200', isTelemetry, controller.signal)
        ]);
        if (!active) return;
        setSnapshot({ leaderboard: leaderboard.sort((a, b) => b.reputationBps - a.reputationBps || b.scoredCount - a.scoredCount), events: events.sort((a, b) => timeValue(b.ts) - timeValue(a.ts)), telemetry: telemetry.sort((a, b) => timeValue(b.ts) - timeValue(a.ts)) });
        setLoaded(true); setError(''); setUpdated(Date.now());
      } catch (e) { if (active && !controller.signal.aborted) setError(e instanceof Error ? e.message : 'Unable to reach the indexer.'); }
      finally { inFlight = false; busy.current = false; }
    }
    void load();
    const interval = window.setInterval(() => void load(), 15000);
    // SSE is an invalidation signal: REST remains authoritative and deduplicates replayed events.
    const source = new EventSource('/api/stream');
    let debounce: number | undefined;
    const invalidate = () => { if (debounce !== undefined) return; debounce = window.setTimeout(() => { debounce = undefined; void load(); }, 400); };
    source.onopen = () => { setStream('live'); invalidate(); };
    source.onerror = () => setStream('reconnecting');
    source.onmessage = invalidate;
    for (const event of ['event', 'events', 'program', 'telemetry', 'agent_telemetry', ...kinds]) source.addEventListener(event, invalidate);
    return () => { active = false; controller.abort(); clearInterval(interval); clearTimeout(debounce); source.close(); };
  }, [refresh]);
  useEffect(() => { document.title = `${current.page === 'market' ? current.symbol : current.page === 'feed' ? 'Live feed' : 'Leaderboard'} · Delphi`; }, [current]);
  const symbols = [...new Set([...snapshot.events, ...snapshot.telemetry].map(symbolOf).filter((s): s is string => !!s))].sort();
  const selected = current.page === 'market' ? current.symbol : filter;
  const events = selected ? snapshot.events.filter(e => symbolOf(e) === selected) : snapshot.events;
  const telemetry = selected ? snapshot.telemetry.filter(t => symbolOf(t) === selected) : snapshot.telemetry;
  const latestMetrics = telemetry.find(t => ['pooled', 'marketPrice', 'edge'].some(k => finite(t.detail[k])));
  return <><a className="skip-link" href="#main" onClick={e => { e.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to content</a><header className="header"><div className="brand"><a href="#/" aria-label="Delphi home">Delphi<span className="brand-dot">.</span></a><span className="tagline">forecast intelligence</span><span className="network">Solana devnet</span></div><nav aria-label="Primary"><a href="#/" aria-current={current.page === 'leaderboard' ? 'page' : undefined}>Leaderboard</a><a href="#/feed" aria-current={current.page === 'feed' ? 'page' : undefined}>Live feed</a></nav><div className="connection" role="status"><span className={`dot ${error ? 'offline' : stream}`} />{error ? 'Indexer unavailable' : stream === 'live' ? 'Stream connected' : stream === 'connecting' ? 'Connecting' : 'Stream reconnecting'}</div></header><main id="main" tabIndex={-1}><div className="eyebrow">DELPHI / RESEARCH TERMINAL</div><div className="page-heading"><div><h1>{current.page === 'leaderboard' ? 'Signal, measured.' : current.page === 'feed' ? 'Inside the loop.' : current.page === 'market' ? 'Market intelligence.' : 'Page not found.'}</h1><p className="subtitle">{current.page === 'leaderboard' ? 'Forecast reputation built from resolved outcomes, not promises.' : current.page === 'feed' ? 'On-chain evidence and agent decisions, side by side.' : current.page === 'market' ? current.symbol : 'This route does not exist.'}</p></div><button onClick={reload}>Refresh <span aria-hidden="true">↻</span></button></div><div className="status-line"><span>{updated ? `Snapshot ${date(updated)}` : 'Awaiting first snapshot'}</span><span>REST refresh every 15s · SSE updates</span></div>{error && <div className="alert" role="alert"><strong>Data could not be refreshed.</strong> {error} {loaded ? 'Showing the last successful snapshot.' : 'Check the indexer connection and retry.'}<button onClick={reload}>Retry</button></div>}{!loaded && !error && <div className="loading" role="status">Connecting to the indexer…</div>}
      {current.page === 'leaderboard' && loaded && <><section className="panel" aria-labelledby="ranking-heading"><div className="section-heading panel-heading"><h2 id="ranking-heading">Forecaster leaderboard</h2><span className="count">{snapshot.leaderboard.length} registered</span></div>{snapshot.leaderboard.length ? <div className="table-scroll" role="region" aria-label="Forecaster rankings" tabIndex={0}><table><caption className="sr-only">Forecasters ordered by reputation, then scored forecasts</caption><thead><tr><th scope="col">Rank / Forecaster</th><th scope="col">Reputation</th><th scope="col">Scored</th><th scope="col">Reads</th><th scope="col">Earned USDC</th></tr></thead><tbody>{snapshot.leaderboard.map((r, i) => <tr key={r.forecasterPda}><th scope="row"><div className="identity"><span className="rank">{String(i + 1).padStart(2, '0')}</span><div><span className="name">{r.name}</span><a className="address" href={`https://explorer.solana.com/address/${encodeURIComponent(r.forecasterPda)}?cluster=devnet`} target="_blank" rel="noreferrer" aria-label={`View ${r.name} forecaster account`}>{r.forecasterPda.slice(0, 6)}…{r.forecasterPda.slice(-4)} ↗</a></div></div></th><td><span className="reputation">{pct(r.reputationBps / 10000)}</span><div className="meter" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, r.reputationBps / 100))}%` }} /></div>{r.scoredCount === 0 && <small>Unscored baseline</small>}</td><td>{number.format(r.scoredCount)}</td><td>{number.format(r.totalReads)}</td><td>{usdc.format(r.earnedUsdc)}</td></tr>)}</tbody></table></div> : <Empty title="Reputation starts with evidence">No forecasters indexed yet. Registered forecasters will appear as the indexer syncs on-chain accounts.</Empty>}</section><div className="method-note"><strong>How to read this</strong><p>Reputation is 100% minus average Brier loss. Higher is better; an unscored forecaster starts at 50%. Reads are buyer-reported, not independently verified payment counts. Performance is experimental and devnet balances have no monetary value.</p></div></>}
      {current.page === 'feed' && loaded && <><div className="filter-bar"><label htmlFor="market-filter">Instrument</label><select id="market-filter" value={filter} onChange={e => setFilter(e.target.value)}><option value="">All instruments</option>{symbols.map(s => <option key={s} value={s}>{s}</option>)}</select><span className="muted">Latest 200 entries per source</span></div><Activity events={events} telemetry={telemetry} market={!!filter} /></>}
      {current.page === 'market' && loaded && <><a className="back" href="#/feed">← All activity</a><section className="panel market-summary" aria-labelledby="observation-heading"><h2 id="observation-heading">Latest agent observation</h2>{latestMetrics ? <><Metrics detail={latestMetrics.detail} /><p className="muted">Reported {date(latestMetrics.ts)} · {latestMetrics.stage} stage. Values are from one telemetry entry, not a live quote.</p></> : <p className="muted">No numeric pooled forecast, market price or edge has been reported for this instrument in the current window.</p>}</section><p className="window-note">Showing exact instrument-symbol matches in the latest 200 entries per source. Events without symbol enrichment are excluded. Purchase events are buyer-reported; this is not a complete order book.</p><Activity events={events} telemetry={telemetry} market /></>}
      {current.page === 'missing' && <Empty title="Find your way back"><a href="#/">Open the leaderboard</a> or <a href="#/feed">explore activity</a>.</Empty>}
    </main><footer><span>Delphi / Forecast intelligence</span><span>Experimental research · Devnet only · Not investment advice</span></footer></>;
}
class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <main><h1>Unable to render the dashboard.</h1><p>Reload to reconnect to the indexer.</p><button onClick={() => window.location.reload()}>Reload</button></main> : this.props.children; }
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Boundary><App /></Boundary></React.StrictMode>);
