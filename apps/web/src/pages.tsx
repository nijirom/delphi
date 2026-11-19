import React, { useEffect, useId, useState } from 'react';
import { type AgentTelemetry, type IndexerEvent, type LeaderboardRow, type MarketDetail, type MarketSummary, cents, finite, get, isDetail, isEvent, isTelemetry, list, marketHref, pct, symbolOf, text, until, ago } from './api.js';
import { PriceChart } from './chart.js';
import { Address, Bar, Empty, EventLine, ExplorerLink, Icon, isLiveMarket, MarketCard, MarketListRow, OutcomeRow, Purchase, QuoteAge, Status, TelemetryLine } from './ui.js';

export type Snapshot = { markets: MarketSummary[]; leaderboard: LeaderboardRow[]; events: IndexerEvent[]; telemetry: AgentTelemetry[]; categories: string[] };

type DetailState = { symbol?: string; detail?: MarketDetail; events?: IndexerEvent[]; telemetry?: AgentTelemetry[]; error?: string };
function useDetail(symbol: string, tick: number): DetailState {
  const [state, setState] = useState<DetailState>({});
  useEffect(() => {
    const controller = new AbortController();
    const encoded = encodeURIComponent(symbol);
    Promise.all([
      get(`markets/${encoded}`, isDetail, controller.signal),
      get(`events?symbol=${encoded}&limit=300`, list(isEvent), controller.signal),
      get(`telemetry?symbol=${encoded}&limit=300`, list(isTelemetry), controller.signal),
    ]).then(([detail, events, telemetry]) => {
      if (!controller.signal.aborted) setState({ symbol, detail, events, telemetry });
    }).catch(e => {
      if (!controller.signal.aborted) setState(s => ({ ...(s.symbol === symbol ? s : {}), symbol, error: e instanceof Error ? e.message : 'Unavailable' }));
    });
    return () => controller.abort();
  }, [symbol, tick]);
  return state.symbol === symbol ? state : {};
}
const decisionOf = (m: MarketSummary) => {
  const d = m.latestDecision?.detail ?? {};
  return { pooled: finite(d.probability) ? d.probability : undefined, edge: finite(d.edge) ? d.edge : undefined, side: text(d.side) ? d.side : undefined, size: finite(d.reservedUsdc) ? d.reservedUsdc : finite(d.size) ? d.size : undefined, stage: m.latestDecision?.stage, reason: text(d.reason) ? d.reason.replaceAll('_', ' ') : undefined, ts: m.latestDecision?.ts };
};
const terminalTabs = [['purchases', 'Purchases'], ['scoring', 'Scoring'], ['rules', 'Rules']] as const;

export function Home({ snap, tick, query, category }: { snap: Snapshot; tick: number; query: string; category: string }) {
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [sort, setSort] = useState<'live' | 'expiry' | 'reads' | 'forecasts'>('live');
  const [showEmpty, setShowEmpty] = useState(false);
  const [slide, setSlide] = useState(0);
  const q = query.trim().toLowerCase();
  const matched = snap.markets.filter(m => (!category || m.category === category) && (!q || m.instrumentSymbol.toLowerCase().includes(q) || (m.title ?? '').toLowerCase().includes(q)));
  const nonEmpty = matched.filter(m => isLiveMarket(m) || m.forecasts > 0);
  const hiddenCount = q ? 0 : matched.length - nonEmpty.length;
  const visible = q || showEmpty ? matched : nonEmpty;
  const sorted = visible.sort((a, b) => {
    if (sort === 'reads') return b.reads - a.reads;
    if (sort === 'forecasts') return b.forecasts - a.forecasts;
    const aExpiry = Date.parse(a.expiryDate ?? ''), bExpiry = Date.parse(b.expiryDate ?? '');
    if (sort === 'expiry') return (Number.isFinite(aExpiry) ? aExpiry : Infinity) - (Number.isFinite(bExpiry) ? bExpiry : Infinity);
    const aLive = isLiveMarket(a), bLive = isLiveMarket(b);
    if (aLive !== bLive) return aLive ? -1 : 1;
    if (aLive) return aExpiry - bExpiry;
    // Keep settled history accessible, newest first; missing expiries come last.
    return (Number.isFinite(bExpiry) ? bExpiry : -Infinity) - (Number.isFinite(aExpiry) ? aExpiry : -Infinity);
  });
  // One card per event (a matchup's two legs are one story), and a featured market with no forecast has nothing to sell.
  const liveQuoted = sorted.filter(m => isLiveMarket(m) && finite(m.quote.mid));
  const byEvent = new Map<string, MarketSummary>();
  for (const m of liveQuoted) {
    const key = m.eventTicker ?? m.marketPda;
    const held = byEvent.get(key);
    if (!held || m.forecasts > held.forecasts || (m.forecasts === held.forecasts && (m.quote.mid ?? 0) > (held.quote.mid ?? 0))) byEvent.set(key, m);
  }
  const candidates = [...byEvent.values()];
  const withForecasts = candidates.filter(m => m.forecasts > 0);
  const featured = (withForecasts.length ? withForecasts : candidates).slice(0, 8);
  const index = Math.min(slide, Math.max(0, featured.length - 1));
  const hero = featured[index];
  useEffect(() => setSlide(0), [q, category]);
  useEffect(() => setSlide(s => Math.min(s, Math.max(0, featured.length - 1))), [featured.length]);
  return <>
    <section className="hero">
      {hero ? <Featured m={hero} tick={tick} index={index} total={featured.length} onMove={d => setSlide((index + d + featured.length) % featured.length)} /> : <div className="panel hero-main"><Empty title={q || category ? 'No matching live markets' : 'No live markets'}>{q || category ? 'Try another search or category. Expired and resolved matches remain below.' : 'Featured markets require an active Gemini contract with a known future expiry and an observed quote.'}</Empty></div>}
      <aside className="hero-side">
        <div className="panel"><div className="panel-title">Top forecasters<a className="chip-link" href="#/forecasters">Leaderboard ›</a></div>{snap.leaderboard.length ? snap.leaderboard.slice(0, 6).map((r, i) => <a key={r.forecasterPda} className="row" href="#/forecasters"><span><small className="muted num">{String(i + 1).padStart(2, '0')} </small>{r.name}</span><span className="num">{pct(r.reputationBps / 10000)}<small> · {r.scoredCount ? `${r.scoredCount} scored` : 'prior · 0 scored'}</small></span></a>) : <p className="muted">No forecasters registered.</p>}</div>
      </aside>
    </section>
    <section className="markets-head"><h2>Markets <span className="count">{sorted.length}</span></h2><div className="controls">{hiddenCount > 0 && <button className="chip" aria-pressed={showEmpty} onClick={() => setShowEmpty(v => !v)}>{showEmpty ? 'Hide empty' : `Show empty (${hiddenCount})`}</button>}<div className="seg" role="group" aria-label="View"><button aria-label="Grid view" aria-pressed={view === 'grid'} onClick={() => setView('grid')}>▦</button><button aria-label="List view" aria-pressed={view === 'list'} onClick={() => setView('list')}>☰</button></div><select aria-label="Sort" value={sort} onChange={e => setSort(e.target.value as typeof sort)}><option value="live">Live first</option><option value="expiry">Expiry ↑</option><option value="reads">Reads ↓</option><option value="forecasts">Forecasts ↓</option></select></div></section>
    {sorted.length ? view === 'grid' ? <div className="grid">{sorted.map(m => <MarketCard key={m.marketPda} m={m} />)}</div> : <div className="list">{sorted.map(m => <MarketListRow key={m.marketPda} m={m} />)}</div> : <Empty title="No matching markets">{q || category ? 'Try another search or category.' : 'No markets have been initialised on-chain yet.'}</Empty>}
  </>;
}

function Featured({ m, tick, index, total, onMove }: { m: MarketSummary; tick: number; index: number; total: number; onMove: (d: number) => void }) {
  const { detail, events, error } = useDetail(m.instrumentSymbol, tick);
  const yes = m.quote.mid, d = decisionOf(m);
  const purchases = (events ?? []).filter(e => e.kind === 'purchase_recorded').slice(0, 3);
  return <div className="panel hero-main">
    <div className="hero-cols">
      <div className="hero-left">
        <div className="card-head"><Icon category={m.category} /><div><h2><a href={marketHref(m.instrumentSymbol)}>{m.title ?? m.instrumentSymbol}</a></h2><span className="sym">{m.instrumentSymbol}</span></div></div>
        <OutcomeRow label="Yes" price={yes} tone="yes" won={m.resolved && m.outcomeYes !== null ? m.outcomeYes : undefined} /><OutcomeRow label="No" price={finite(yes) ? 1 - yes : null} tone="no" won={m.resolved && m.outcomeYes !== null ? !m.outcomeYes : undefined} />
        <QuoteAge m={m} />
        <div className="subhead">Recent purchases</div>
        {purchases.length ? purchases.map(e => <Purchase key={e.id} e={e} dense />) : <p className="muted">{!events ? error ? 'Purchase history unavailable.' : 'Loading purchase history…' : 'No purchases in recent indexed activity.'}</p>}
        <a className="more" href={marketHref(m.instrumentSymbol)}>{m.forecasts === 0 ? 'No forecasts committed yet' : `${m.forecasts} ${m.forecasts === 1 ? 'forecast' : 'forecasts'}`} · open terminal ›</a>
      </div>
      <div className="hero-chart">
        <div className="legend"><span className="swatch yes" /> Yes mid {cents(yes)}{finite(d.pooled) && <><span className="swatch pool" /> Pooled {cents(d.pooled)}</>}</div>
        {detail ? <PriceChart prices={detail.prices} pooled={d.pooled} /> : <p className="muted">{error ? 'Chart unavailable.' : 'Loading chart…'}</p>}
      </div>
    </div>
    <div className="hero-foot"><span>{m.forecasts === 0 ? 'Awaiting the first commitment' : `${m.reads} ${m.reads === 1 ? 'read' : 'reads'} · ${m.revealed}/${m.forecasts} scored`}</span><span className="pager">{m.category ?? 'Market'} <button aria-label="Previous featured market" disabled={total < 2} onClick={() => onMove(-1)}>‹</button> {index + 1} of {total} <button aria-label="Next featured market" disabled={total < 2} onClick={() => onMove(1)}>›</button></span></div>
  </div>;
}

export function Terminal({ symbol, snap, tick }: { symbol: string; snap: Snapshot; tick: number }) {
  const { detail, events: marketEvents, telemetry: marketTelemetry, error } = useDetail(symbol, tick);
  const [win, setWin] = useState<number | undefined>(undefined);
  const [tab, setTab] = useState<'purchases' | 'scoring' | 'rules'>('purchases');
  const tabId = useId();
  const summary = detail ?? snap.markets.find(m => m.instrumentSymbol === symbol);
  if (!summary) return error ? <Empty title="Market not found">{error} — <a href="#/">back to markets</a></Empty> : <Empty title="Loading market" />;
  const d = decisionOf(summary), q = summary.quote;
  const revealedForecasts = (detail?.forecastList ?? []).filter(f => f.revealed && finite(f.probBps));
  const consensusProb: number | undefined = d.pooled === undefined && revealedForecasts.length > 0 ? (() => {
    let weightSum = 0, logitSum = 0;
    for (const f of revealedForecasts) {
      const p = Math.min(0.99, Math.max(0.01, f.probBps! / 10000));
      const w = Math.max(1, f.reputationBps);
      weightSum += w;
      logitSum += w * Math.log(p / (1 - p));
    }
    const logit = logitSum / weightSum;
    return 1 / (1 + Math.exp(-logit));
  })() : undefined;
  const chartPooled = d.pooled ?? consensusProb;
  const events = marketEvents ?? [], telemetry = marketTelemetry ?? [];
  const purchases = events.filter(e => e.kind === 'purchase_recorded');
  const askYes = q.bestAsk, askNo = finite(q.bestBid) ? 1 - q.bestBid : null;
  const spread = finite(q.bestAsk) && finite(q.bestBid) ? q.bestAsk - q.bestBid : null;
  return <div className="terminal">
    <header className="t-head"><a className="back-link" href="#/">‹ Markets</a><Icon category={summary.category} /><div><h2>{summary.title ?? symbol}</h2><span className="sym">{symbol}{summary.category ? ` · ${summary.category}` : ''}{summary.eventTicker ? ` · event ${summary.eventTicker}` : ''}</span></div><Status m={summary} /></header>
    {error && <div className="alert t-error" role="alert">{error} Showing the last available market snapshot.</div>}
    <section className="panel t-chart">
      <div className="t-bar"><div className="seg" role="group" aria-label="Window">{([['5m', 300e3], ['15m', 900e3], ['1h', 3600e3], ['All', undefined]] as const).map(([l, ms]) => <button key={l} aria-pressed={win === ms} onClick={() => setWin(ms)}>{l}</button>)}</div><div className="legend"><span className="swatch yes" /> Yes mid{finite(chartPooled) && <><span className="swatch pool" /> {finite(d.pooled) ? 'Pooled forecast' : 'Revealed consensus'}</>}</div></div>
      {detail ? <PriceChart prices={detail.prices} pooled={chartPooled} windowMs={win} /> : <p className="muted">{error ? 'Chart unavailable.' : 'Loading chart…'}</p>}
      <div className="subhead">Forecasts <span className="count">{detail?.forecastList.length ?? summary.forecasts}</span></div>
      {detail?.forecastList.length ? <div className="table-scroll" role="region" aria-label="Market forecasts" tabIndex={0}><table className="tbl"><thead><tr><th>Read price</th><th>Forecaster</th><th>Reputation</th><th>Status</th><th>Bond</th><th>Reads</th><th>Posted</th></tr></thead><tbody>{detail.forecastList.map(f => <tr key={f.forecastPda}><td className="yes">${f.pricePerReadUsdc.toFixed(3)}</td><td>{f.forecasterName}</td><td>{pct(f.reputationBps / 10000)}</td><td>{f.revealed ? <span className="badge yes">revealed {(f.probBps! / 100).toFixed(1)}% · brier {f.brierBps}</span> : f.forfeited ? <span className="badge no">forfeited · brier {f.brierBps}</span> : <span className="badge">committed</span>}</td><td>{f.bond ? <span className={`badge${f.bond.state === 'refunded' ? ' yes' : f.bond.state === 'slashed' ? ' no' : ''}`} title={f.bond.state === 'escrowed' ? 'Held in a program vault until the forecast is revealed (refund) or forfeited (slashed)' : undefined}>${f.bond.amountUsdc.toFixed(2)} {f.bond.state}</span> : <span className="muted">none</span>}</td><td>{f.reads}</td><td className="muted">{ago(f.postedAt)}</td></tr>)}</tbody></table></div> : <p className="muted">{!detail ? error ? 'Forecast details unavailable.' : 'Loading forecasts…' : 'No forecasts committed on this market.'}</p>}
    </section>
    <section className="panel t-book">
      <div className="panel-title">Gemini quote</div>
      <QuoteAge m={summary} />
      <p className="muted small">{isLiveMarket(summary) ? 'Indicative Gemini observations, not execution prices.' : 'Last observed prices; this market is not confirmed live.'}</p>
      <dl className="kv"><div><dt>Best bid</dt><dd>{cents(q.bestBid)}</dd></div><div><dt>Best ask</dt><dd>{cents(q.bestAsk)}</dd></div><div><dt>Last trade</dt><dd>{cents(q.lastTradePrice)}</dd></div><div><dt>Spread</dt><dd>{cents(spread)}</dd></div><div><dt>Expiry</dt><dd>{until(summary.expiryDate)}</dd></div></dl>
      <div className="subhead">Recent purchases <span className="count">{purchases.length}</span></div>
      {purchases.length ? purchases.slice(0, 12).map(e => <Purchase key={e.id} e={e} dense />) : <p className="muted">{!marketEvents ? error ? 'Purchase history unavailable.' : 'Loading purchase history…' : 'No purchases in recent indexed activity.'}</p>}
      <div className="subhead">Agent log <span className="count">{telemetry.length}</span></div>
      {telemetry.length ? telemetry.slice(0, 8).map((t, i) => <TelemetryLine key={`${t.ts}-${t.stage}-${t.instrumentSymbol ?? ''}-${i}`} t={t} />) : <p className="muted">{!marketTelemetry ? error ? 'Agent history unavailable.' : 'Loading agent history…' : 'No telemetry indexed for this market.'}</p>}
    </section>
    <section className="panel ticket">
      <div className="ticket-tabs"><span className="on">Agent decision</span><span className="muted">read-only</span></div>
      <div className="subhead">{isLiveMarket(summary) ? 'Current' : 'Last'} indicative asks</div>
      <div className="sides"><div className="side-btn yes">Yes {cents(askYes)}</div><div className="side-btn no">No {cents(askNo)}</div></div>
      <dl className="kv"><div><dt>Reported side</dt><dd>{d.side === 'yes' ? 'Yes' : d.side === 'no' ? 'No' : '—'}</dd></div><div><dt>{finite(d.pooled) ? 'Pooled probability' : finite(consensusProb) ? 'Revealed consensus' : 'Pooled probability'}</dt><dd>{finite(chartPooled) ? pct(chartPooled) : '—'}</dd></div><div><dt>Reported edge</dt><dd className={finite(d.edge) ? (d.edge > 0 ? 'yes' : 'no') : ''}>{finite(d.edge) ? pct(d.edge) : '—'}</dd></div><div><dt>Reserved size</dt><dd>{finite(d.size) ? `$${d.size.toFixed(2)}` : '—'}</dd></div><div><dt>Last stage</dt><dd>{d.stage ?? '—'}</dd></div><div><dt>Agent telemetry age</dt><dd>{finite(d.ts) ? ago(d.ts) : '—'}</dd></div></dl>
      <div className={`cta ${d.stage === 'trade' ? 'yes' : ''}`}>{d.stage === 'trade' ? 'Order submitted' : d.stage === 'skip' ? `Skipped · ${d.reason ?? 'no action'}` : d.stage === 'error' ? 'Agent error · inspect activity' : d.stage === 'approve' ? 'Approval requested' : d.stage === 'decide' ? 'Awaiting approval / order' : 'No decision reported'}</div>
      <p className="muted small">Asks are the latest Gemini observations (No is derived from the Yes bid), not the agent's historical decision or fill prices. Decision fields and their age come from agent telemetry. Read-only; no order can be placed here.</p>
    </section>
    <section className="panel t-tabs">
      <div className="tabs" role="tablist" aria-label="Market records">{terminalTabs.map(([key, label], current) => <button key={key} id={`${tabId}-${key}`} role="tab" aria-selected={tab === key} aria-controls={`${tabId}-panel`} tabIndex={tab === key ? 0 : -1} onClick={() => setTab(key)} onKeyDown={e => {
        const next = e.key === 'ArrowRight' ? (current + 1) % terminalTabs.length : e.key === 'ArrowLeft' ? (current + terminalTabs.length - 1) % terminalTabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? terminalTabs.length - 1 : undefined;
        if (next === undefined) return;
        e.preventDefault();
        setTab(terminalTabs[next][0]);
        e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
      }}>{label}</button>)}</div>
      <div id={`${tabId}-panel`} role="tabpanel" aria-labelledby={`${tabId}-${tab}`} tabIndex={0}>
      <p className="muted small">Recent indexed history: up to 300 events for this market. On-chain totals: {summary.reads} reads · {summary.revealed}/{summary.forecasts} scored.</p>
      {tab === 'purchases' && (purchases.length ? <div className="table-scroll" role="region" aria-label="Market purchases" tabIndex={0}><table className="tbl"><thead><tr><th>Buyer</th><th>Action</th><th>Amount</th><th>Time</th><th>Tx</th></tr></thead><tbody>{purchases.map(e => <tr key={e.id}><td><Address value={String(e.data.buyer)} /></td><td className="yes">Buy read</td><td>${(Number(e.data.amount) / 1e6).toFixed(3)}</td><td className="muted">{ago(e.ts)}</td><td><ExplorerLink kind="tx" value={e.signature} /></td></tr>)}</tbody></table></div> : <Empty title={!marketEvents ? error ? 'Purchase history unavailable' : 'Loading purchases' : 'No purchases in recent indexed history'}>Paid reads recorded with <code>record_purchase</code> appear here. Reads are buyer-reported; an empty event window is not proof of no purchases.</Empty>)}
      {tab === 'scoring' && (events.some(e => e.kind === 'forecast_scored' || e.kind === 'market_resolved') ? events.filter(e => e.kind === 'forecast_scored' || e.kind === 'market_resolved').map(e => <EventLine key={e.id} e={e} />) : <Empty title={!marketEvents ? error ? 'Scoring history unavailable' : 'Loading scores' : 'No scoring events in recent indexed history'}>On-chain scores are shown in the forecast table above. Missing indexed events do not mean a forecast is unscored.</Empty>)}
      {tab === 'rules' && <div className="rules"><p>Forecasters commit <code>sha256(prob_bps ‖ salt)</code> on-chain; the probability is sold per read via x402 using the configured USDC mint (a test token on localnet).</p><p>Resolution mirrors Gemini's <code>resolutionSide</code> for <code>{symbol}</code>. Anyone holding a paid reveal can call <code>reveal_and_score</code>; one hour after resolution anyone can <code>forfeit_forecast</code> an unrevealed commitment, scoring it at Brier 10000.</p><p>Score: <code>brier_bps = (prob_bps − outcome·10000)² / 10000</code>; reputation = <code>10000 − floor((Σ brier + 5·5000) / (scored + 5))</code>, so a short record is shrunk toward 50 %. Lower Brier is better.</p><p>Experimental research. Check the network indicator before interpreting balances or transactions. Not investment advice.</p></div>}
      </div>
    </section>
  </div>;
}

export function Forecasters({ rows }: { rows: LeaderboardRow[] }) {
  return <section className="panel"><div className="panel-title">Forecasters <span className="count">{rows.length}</span></div>{rows.length ? <div className="table-scroll" role="region" aria-label="Forecaster leaderboard" tabIndex={0}><table className="tbl wide"><thead><tr><th>#</th><th>Forecaster</th><th>Authority</th><th>Reputation</th><th>Scored</th><th>Reads</th><th>Earned USDC</th></tr></thead><tbody>{rows.map((r, i) => {
    const tone = r.scoredCount === 0 ? 'pool' : r.reputationBps >= 5000 ? 'yes' : 'no';
    return <tr key={r.forecasterPda}><td className="muted">{String(i + 1).padStart(2, '0')}</td><td><b>{r.name}</b></td><td><Address value={r.authority} /></td><td><span className={`rep ${tone === 'no' ? 'no' : tone === 'pool' ? 'muted' : 'yes'}`}>{pct(r.reputationBps / 10000)}</span><Bar value={r.reputationBps / 10000} tone={tone} /><small className="muted">{r.scoredCount > 0 ? `${r.reputationBps >= 5000 ? '+' : ''}${((r.reputationBps - 5000) / 100).toFixed(2)}% vs 50% prior · ${r.scoredCount} scored` : 'unscored · 50% prior'}</small></td><td>{r.scoredCount}</td><td>{r.totalReads}</td><td>${r.earnedUsdc.toFixed(2)}</td></tr>;
  })}</tbody></table></div> : <Empty title="No forecasters registered" />}<p className="muted small">Reads are buyer-reported; earned USDC is derived from confirmed token-balance changes.</p></section>;
}

const eventFilters = [['all', 'All'], ['forecast_scored', 'Scored'], ['market_resolved', 'Resolved'], ['purchase_recorded', 'Purchases'], ['forecast_posted', 'Posted'], ['usdc_transfer', 'USDC']] as const;
const stageFilters = [['all', 'All'], ['active', 'Decisions'], ['skip', 'Skips'], ['error', 'Errors']] as const;

export function Activity({ snap, query }: { snap: Snapshot; query: string }) {
  const [eventFilter, setEventFilter] = useState<string>('all');
  const [stageFilter, setStageFilter] = useState<string>('all');
  const q = query.trim().toLowerCase();
  const events = (q ? snap.events.filter(e => (symbolOf(e) ?? '').toLowerCase().includes(q)) : snap.events).filter(e => eventFilter === 'all' || e.kind === eventFilter);
  const telemetry = (q ? snap.telemetry.filter(t => (symbolOf(t) ?? '').toLowerCase().includes(q)) : snap.telemetry).filter(t => stageFilter === 'all' || (stageFilter === 'active' ? ['buy', 'aggregate', 'decide', 'approve', 'trade'].includes(t.stage) : t.stage === stageFilter));
  return <div className="two">
    <section className="panel">
      <div className="panel-title">Program events <span className="count">{events.length}</span><div className="seg filter-bar" role="group" aria-label="Filter program events">{eventFilters.map(([k, l]) => <button key={k} type="button" aria-pressed={eventFilter === k} onClick={() => setEventFilter(k)}>{l}</button>)}</div></div>
      {events.length ? events.map(e => <EventLine key={e.id} e={e} />) : <Empty title="No program events" />}
    </section>
    <section className="panel">
      <div className="panel-title">Agent telemetry <span className="count">{telemetry.length}</span><div className="seg filter-bar" role="group" aria-label="Filter agent telemetry">{stageFilters.map(([k, l]) => <button key={k} type="button" aria-pressed={stageFilter === k} onClick={() => setStageFilter(k)}>{l}</button>)}</div></div>
      {telemetry.length ? telemetry.map((t, i) => <TelemetryLine key={`${t.ts}-${t.stage}-${t.instrumentSymbol ?? ''}-${i}`} t={t} />) : <Empty title="Waiting for agent activity">Nothing is simulated.</Empty>}
    </section>
  </div>;
}
