import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ago, get, isEvent, isHealth, isMarket, isRow, isTelemetry, list, text, timeValue, type Network } from './api.js';
import { Activity, Forecasters, Home, type Snapshot, Terminal } from './pages.js';
import { Docs, type DocSlug, docHref, isDocSlug } from './docs.js';
import { ExplorerLink, NetworkContext } from './ui.js';
import './style.css';

type Route = { page: 'markets' | 'forecasters' | 'activity' | 'market' | 'docs' | 'missing'; symbol?: string; doc?: DocSlug };
function route(): Route {
  const hash = window.location.hash || '#/';
  if (hash === '#/' || hash === '#') return { page: 'markets' };
  if (hash === '#/forecasters') return { page: 'forecasters' };
  if (hash === '#/activity' || hash === '#/feed') return { page: 'activity' };
  if (hash === '#/docs') return { page: 'docs', doc: 'readme' };
  if (hash.startsWith('#/docs/')) { const doc = hash.slice('#/docs/'.length); if (isDocSlug(doc)) return { page: 'docs', doc }; }
  if (hash.startsWith('#/market/')) {
    try { const symbol = decodeURIComponent(hash.slice('#/market/'.length)); if (symbol && symbol.length <= 64) return { page: 'market', symbol }; } catch { /* invalid route */ }
  }
  return { page: 'missing' };
}
const EMPTY: Snapshot = { markets: [], leaderboard: [], events: [], telemetry: [], categories: [] };

function App() {
  const [current, setCurrent] = useState<Route>(route);
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [updated, setUpdated] = useState<number>();
  const [tick, setTick] = useState(0);
  const [stream, setStream] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [snapshotAt, setSnapshotAt] = useState<number | null>(null);
  const [network, setNetwork] = useState<Network | null>(null);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const change = () => { setCurrent(route()); window.scrollTo(0, 0); };
    const keys = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); search.current?.focus(); search.current?.select(); } };
    window.addEventListener('hashchange', change); window.addEventListener('keydown', keys);
    return () => { window.removeEventListener('hashchange', change); window.removeEventListener('keydown', keys); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true, inFlight = false, queued = false;
    async function load() {
      if (!active) return;
      if (inFlight) { queued = true; return; }
      queued = false;
      inFlight = true;
      try {
        const [markets, leaderboard, events, telemetry, categories, health] = await Promise.all([
          get('markets', list(isMarket), controller.signal), get('leaderboard', list(isRow), controller.signal),
          get('events?limit=300', list(isEvent), controller.signal), get('telemetry?limit=300', list(isTelemetry), controller.signal),
          get('categories', list(text), controller.signal),
          get('health', isHealth, controller.signal),
        ]);
        if (!active) return;
        if (!health.ok || health.snapshotAt === null || Date.now() - health.snapshotAt >= 180000) throw new Error('Indexer chain snapshot is stale.');
        setNetwork(health.network);
        setSnap({ markets, categories, leaderboard: leaderboard.sort((a, b) => Number(b.scoredCount > 0) - Number(a.scoredCount > 0) || b.reputationBps - a.reputationBps || b.scoredCount - a.scoredCount), events: events.sort((a, b) => timeValue(b.ts) - timeValue(a.ts)), telemetry: telemetry.sort((a, b) => timeValue(b.ts) - timeValue(a.ts)) });
        setLoaded(true); setError(''); setUpdated(Date.now()); setSnapshotAt(health.snapshotAt); setTick(n => n + 1);
      } catch (e) { if (active && !controller.signal.aborted) setError(e instanceof Error ? e.message : 'Unable to reach the indexer.'); }
      finally { inFlight = false; if (queued && active) void load(); }
    }
    void load();
    const interval = window.setInterval(() => { setNow(Date.now()); void load(); }, 15000);
    let source: EventSource | undefined;
    let debounce: number | undefined, reconnect: number | undefined;
    const invalidate = () => { if (debounce === undefined) debounce = window.setTimeout(() => { debounce = undefined; void load(); }, 500); };
    function connect() {
      reconnect = undefined;
      if (!active) return;
      source = new EventSource('/api/stream');
      source.onopen = () => { setStream('live'); invalidate(); };
      source.onerror = () => {
        setStream('reconnecting');
        // HTTP errors can permanently close EventSource; only network disconnects retry natively.
        if (source?.readyState === EventSource.CLOSED && reconnect === undefined) reconnect = window.setTimeout(connect, 3000);
      };
      source.addEventListener('event', invalidate); source.addEventListener('telemetry', invalidate);
    }
    connect();
    return () => { active = false; controller.abort(); clearInterval(interval); clearTimeout(debounce); clearTimeout(reconnect); source?.close(); };
  }, [refresh]);
  useEffect(() => { document.title = `${current.page === 'market' ? current.symbol : current.page[0].toUpperCase() + current.page.slice(1)} · Delphi`; }, [current]);
  const latest = snap.telemetry[0];
  const stale = snapshotAt !== null && now - snapshotAt >= 180000;
  const online = stream === 'live' && !error && !stale && loaded;
  return <NetworkContext.Provider value={network}>
    <a className="skip-link" href="#main" onClick={e => { e.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to content</a>
    <header className="top">
      <a className="logo" href="#/">Delphi<span>.</span></a>
      <nav aria-label="Primary">{([['#/', 'Markets', 'markets'], ['#/forecasters', 'Forecasters', 'forecasters'], ['#/activity', 'Activity', 'activity']] as const).map(([href, label, page]) => <a key={page} href={href} aria-current={current.page === page || (page === 'markets' && current.page === 'market') ? 'page' : undefined}>{label}</a>)}</nav>
      <label className="search"><span aria-hidden="true">⌕</span><input ref={search} value={query} onKeyDown={e => { if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur(); } }} onChange={e => { setQuery(e.target.value); if (current.page !== 'markets' && current.page !== 'activity') window.location.hash = '#/'; }} placeholder="Search markets…" aria-label="Search markets" />{query && <button type="button" className="search-clear" aria-label="Clear search" onClick={() => { setQuery(''); search.current?.focus(); }}>×</button>}<kbd>⌘K</kbd></label>
      <div className="top-right">
        <span className="agent" title="Latest buyer agent stage">{latest ? <><span className={`dot s-${latest.stage}`} />agent · {latest.stage} · {ago(latest.ts)}</> : <><span className="dot" />agent idle</>}</span>
        <span className="net">Solana {network?.cluster === 'custom' ? 'custom RPC' : network?.cluster ?? 'connecting'}</span>
        <a className="btn" href={docHref('readme')}>Docs</a>
      </div>
    </header>
    {current.page === 'markets' && <div className="chips"><span className="chip static">Explore</span><button className="chip" aria-pressed={category === ''} onClick={() => { setCategory(''); window.location.hash = '#/'; }}>All</button>{snap.categories.map(c => <button key={c} className="chip" aria-pressed={category === c} onClick={() => { setCategory(c); window.location.hash = '#/'; }}>{c}</button>)}</div>}
    <main id="main" tabIndex={-1} className={current.page === 'docs' ? 'docs-page' : undefined}>
      {(error || stale) && <div className="alert" role="alert">{error || 'Indexer chain snapshot is stale.'}{loaded ? ' Showing last successful snapshot.' : ''} <button className="btn" onClick={() => setRefresh(n => n + 1)}>Retry now</button></div>}
      {!loaded && !error && <p className="muted">Connecting to the indexer…</p>}
      {loaded && current.page === 'markets' && <Home snap={snap} tick={tick} query={query} category={category} />}
      {loaded && current.page === 'market' && <Terminal symbol={current.symbol!} snap={snap} tick={tick} />}
      {loaded && current.page === 'forecasters' && <Forecasters rows={snap.leaderboard} />}
      {loaded && current.page === 'activity' && <Activity snap={snap} query={query} />}
      {current.page === 'docs' && <Docs slug={current.doc ?? 'readme'} />}
      {current.page === 'missing' && <p className="muted">Nothing here. <a href="#/">Back to markets</a>.</p>}
    </main>
    <footer className="status">
      <span className={online ? 'yes' : 'no'}>● {online ? 'Online' : error || stale ? 'Data unavailable' : !loaded ? 'Connecting' : 'Live updates reconnecting'}</span>
      <span className="muted">{updated ? `snapshot ${ago(updated)}` : ''}</span>
      <span className="muted">⌘K search</span>
      <span className="links"><a href={docHref('architecture')}>Architecture</a><a href={docHref('guardrails')}>Guardrails</a>{network && <ExplorerLink kind="address" value={network.programId}>Program</ExplorerLink>}<a href="https://www.gemini.com/prediction-markets" target="_blank" rel="noreferrer">Gemini</a></span>
    </footer>
  </NetworkContext.Provider>;
}
createRoot(document.getElementById('root')!).render(<App />);
