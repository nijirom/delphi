import React, { useEffect, useState } from 'react';
import { type AgentTelemetry, type IndexerEvent, type LeaderboardRow, type MarketDetail, type MarketSummary, cents, finite, get, isDetail, marketHref, pct, symbolOf, text, until, ago } from './api.js';
import { PriceChart } from './chart.js';
import { Address, Bar, Empty, EventLine, Icon, MarketCard, MarketListRow, OutcomeRow, Purchase, Status, TelemetryLine } from './ui.js';

export type Snapshot = { markets: MarketSummary[]; leaderboard: LeaderboardRow[]; events: IndexerEvent[]; telemetry: AgentTelemetry[]; categories: string[] };

function useDetail(symbol: string, tick: number): { detail?: MarketDetail; error?: string } {
  const [state, setState] = useState<{ symbol?: string; detail?: MarketDetail; error?: string }>({});
  useEffect(() => {
    const controller = new AbortController();
    get(`markets/${encodeURIComponent(symbol)}`, isDetail, controller.signal).then(detail => { if (!controller.signal.aborted) setState({ symbol, detail }); }).catch(e => { if (!controller.signal.aborted) setState(s => ({ symbol, detail: s.symbol === symbol ? s.detail : undefined, error: e instanceof Error ? e.message : 'Unavailable' })); });
    return () => controller.abort();
  }, [symbol, tick]);
  return state.symbol === symbol ? state : {};
}
const decisionOf = (m: MarketSummary) => {
  const d = m.latestDecision?.detail ?? {};
  return { pooled: finite(d.probability) ? d.probability : undefined, edge: finite(d.edge) ? d.edge : undefined, side: text(d.side) ? d.side : undefined, size: finite(d.reservedUsdc) ? d.reservedUsdc : finite(d.size) ? d.size : undefined, stage: m.latestDecision?.stage, reason: text(d.reason) ? d.reason.replaceAll('_', ' ') : undefined, ts: m.latestDecision?.ts };
};

export function Home({ snap, tick, query, category }: { snap: Snapshot; tick: number; query: string; category: string }) {
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [sort, setSort] = useState<'expiry' | 'reads' | 'forecasts'>('expiry');
  const [slide, setSlide] = useState(0);
  const q = query.trim().toLowerCase();
  const visible = snap.markets.filter(m => (!category || m.category === category) && (!q || m.instrumentSymbol.toLowerCase().includes(q) || (m.title ?? '').toLowerCase().includes(q)));
  const sorted = [...visible].sort((a, b) => sort === 'reads' ? b.reads - a.reads : sort === 'forecasts' ? b.forecasts - a.forecasts : Number(a.resolved) - Number(b.resolved) || (Date.parse(a.expiryDate ?? '') || Infinity) - (Date.parse(b.expiryDate ?? '') || Infinity));
  const featured = snap.markets.filter(m => !m.resolved && finite(m.quote.mid)).slice(0, 8);
  const hero = featured[Math.min(slide, Math.max(0, featured.length - 1))];
  return <>
    <section className="hero">
      {hero ? <Featured m={hero} tick={tick} events={snap.events} index={slide} total={featured.length} onMove={d => setSlide(s => (s + d + featured.length) % featured.length)} /> : <div className="panel hero-main"><Empty title="No live markets">Markets appear once the forecaster posts commitments on open Gemini contracts.</Empty></div>}
      <aside className="hero-side">
        <a className="banner" href="#/forecasters"><span>Reputation <b>›</b></span><small>Scored on-chain from Gemini settlements</small></a>
        <div className="panel"><div className="panel-title">Top forecasters</div>{snap.leaderboard.length ? snap.leaderboard.slice(0, 6).map(r => <a key={r.forecasterPda} className="row" href="#/forecasters"><span>{r.name}</span><span className="num">{pct(r.reputationBps / 10000)}<small> · {r.scoredCount} scored</small></span></a>) : <p className="muted">No forecasters registered.</p>}</div>
      </aside>
    </section>
    <section className="markets-head"><h2>Markets <span className="count">{sorted.length}</span></h2><div className="controls"><div className="seg" role="group" aria-label="View"><button aria-label="Grid view" aria-pressed={view === 'grid'} onClick={() => setView('grid')}>▦</button><button aria-label="List view" aria-pressed={view === 'list'} onClick={() => setView('list')}>☰</button></div><select aria-label="Sort" value={sort} onChange={e => setSort(e.target.value as typeof sort)}><option value="expiry">Expiry ↑</option><option value="reads">Reads ↓</option><option value="forecasts">Forecasts ↓</option></select></div></section>
    {sorted.length ? view === 'grid' ? <div className="grid">{sorted.map(m => <MarketCard key={m.marketPda} m={m} />)}</div> : <div className="list">{sorted.map(m => <MarketListRow key={m.marketPda} m={m} />)}</div> : <Empty title="No matching markets">{q || category ? 'Try another search or category.' : 'No markets have been initialised on-chain yet.'}</Empty>}
  </>;
}

function Featured({ m, tick, events, index, total, onMove }: { m: MarketSummary; tick: number; events: IndexerEvent[]; index: number; total: number; onMove: (d: number) => void }) {
  const { detail } = useDetail(m.instrumentSymbol, tick);
  const yes = m.quote.mid, d = decisionOf(m);
  const purchases = events.filter(e => e.kind === 'purchase_recorded' && symbolOf(e) === m.instrumentSymbol).slice(0, 3);
  return <div className="panel hero-main">
    <div className="hero-cols">
      <div className="hero-left">
        <div className="card-head"><Icon category={m.category} /><div><h2><a href={marketHref(m.instrumentSymbol)}>{m.title ?? m.instrumentSymbol}</a></h2><span className="sym">{m.instrumentSymbol}</span></div></div>
        <OutcomeRow label="Yes" price={yes} tone="yes" /><OutcomeRow label="No" price={finite(yes) ? 1 - yes : null} tone="no" />
        <div className="subhead">Recent purchases</div>
        {purchases.length ? purchases.map(e => <Purchase key={e.id} e={e} dense />) : <p className="muted">No paid reads yet on this market.</p>}
        <a className="more" href={marketHref(m.instrumentSymbol)}>{m.forecasts} forecasts · open terminal ›</a>
      </div>
      <div className="hero-chart">
        <div className="legend"><span className="swatch yes" /> Yes mid {cents(yes)}{finite(d.pooled) && <><span className="swatch pool" /> Pooled {cents(d.pooled)}</>}</div>
        <PriceChart prices={detail?.prices ?? []} pooled={d.pooled} />
      </div>
    </div>
    <div className="hero-foot"><span>{m.reads} reads · {m.revealed}/{m.forecasts} scored</span><span className="pager">{m.category ?? 'Market'} <button aria-label="Previous" onClick={() => onMove(-1)}>‹</button> {index + 1} of {total} <button aria-label="Next" onClick={() => onMove(1)}>›</button></span></div>
  </div>;
}

export function Terminal({ symbol, snap, tick }: { symbol: string; snap: Snapshot; tick: number }) {
  const { detail, error } = useDetail(symbol, tick);
  const [win, setWin] = useState<number | undefined>(undefined);
  const [tab, setTab] = useState<'purchases' | 'scoring' | 'rules'>('purchases');
  const summary = detail ?? snap.markets.find(m => m.instrumentSymbol === symbol);
  if (!summary) return error ? <Empty title="Market not found">{error} — <a href="#/">back to markets</a></Empty> : <Empty title="Loading market" />;
  const d = decisionOf(summary), q = summary.quote;
  const events = snap.events.filter(e => symbolOf(e) === symbol), telemetry = snap.telemetry.filter(t => symbolOf(t) === symbol);
  const purchases = events.filter(e => e.kind === 'purchase_recorded');
  const askYes = q.bestAsk, askNo = finite(q.bestBid) ? 1 - q.bestBid : null;
  const spread = finite(q.bestAsk) && finite(q.bestBid) ? q.bestAsk - q.bestBid : null;
  return <div className="terminal">
    <header className="t-head"><Icon category={summary.category} /><div><h2>{summary.title ?? symbol}</h2><span className="sym">{symbol}{summary.category ? ` · ${summary.category}` : ''}{summary.eventTicker ? ` · event ${summary.eventTicker}` : ''}</span></div><Status m={summary} /></header>
    {error && <div className="alert t-error" role="alert">{error} Showing the last available market snapshot.</div>}
    <section className="panel t-chart">
      <div className="t-bar"><div className="seg" role="group" aria-label="Window">{([['1h', 3600e3], ['4h', 4 * 3600e3], ['1D', 86400e3], ['All', undefined]] as const).map(([l, ms]) => <button key={l} aria-pressed={win === ms} onClick={() => setWin(ms)}>{l}</button>)}</div><div className="legend"><span className="swatch yes" /> Yes mid{finite(d.pooled) && <><span className="swatch pool" /> Pooled forecast</>}</div></div>
      <PriceChart prices={detail?.prices ?? []} pooled={d.pooled} windowMs={win} />
      <div className="subhead">Forecasts <span className="count">{detail?.forecastList.length ?? summary.forecasts}</span></div>
      {detail?.forecastList.length ? <table className="tbl"><thead><tr><th>Read price</th><th>Forecaster</th><th>Reputation</th><th>Status</th><th>Reads</th><th>Posted</th></tr></thead><tbody>{detail.forecastList.map(f => <tr key={f.forecastPda}><td className="yes">${f.pricePerReadUsdc.toFixed(3)}</td><td>{f.forecasterName}</td><td>{pct(f.reputationBps / 10000)}</td><td>{f.revealed ? <span className="badge yes">revealed {(f.probBps! / 100).toFixed(1)}% · brier {f.brierBps}</span> : <span className="badge">committed</span>}</td><td>{f.reads}</td><td className="muted">{ago(f.postedAt)}</td></tr>)}</tbody></table> : <p className="muted">No forecasts committed on this market.</p>}
    </section>
    <section className="panel t-book">
      <div className="panel-title">Gemini quote</div>
      <dl className="kv"><div><dt>Best bid</dt><dd>{cents(q.bestBid)}</dd></div><div><dt>Best ask</dt><dd>{cents(q.bestAsk)}</dd></div><div><dt>Last trade</dt><dd>{cents(q.lastTradePrice)}</dd></div><div><dt>Spread</dt><dd>{cents(spread)}</dd></div><div><dt>Expiry</dt><dd>{until(summary.expiryDate)}</dd></div></dl>
      <div className="subhead">Recent purchases <span className="count">{purchases.length}</span></div>
      {purchases.length ? purchases.slice(0, 12).map(e => <Purchase key={e.id} e={e} dense />) : <p className="muted">No paid reads indexed for this market.</p>}
      <div className="subhead">Agent log <span className="count">{telemetry.length}</span></div>
      {telemetry.length ? telemetry.slice(0, 8).map((t, i) => <TelemetryLine key={i} t={t} />) : <p className="muted">The buyer agent has not reported on this market.</p>}
    </section>
    <section className="panel ticket">
      <div className="ticket-tabs"><span className="on">Agent decision</span><span className="muted">read-only</span></div>
      <div className="sides"><div className={`side-btn yes ${d.side === 'yes' ? 'on' : ''}`}>Yes {cents(askYes)}</div><div className={`side-btn no ${d.side === 'no' ? 'on' : ''}`}>No {cents(askNo)}</div></div>
      <div className="ticket-market"><Icon category={summary.category} /><div><b>{summary.title ?? symbol}</b><small>{symbol}</small></div></div>
      <dl className="kv"><div><dt>Pooled probability</dt><dd>{finite(d.pooled) ? pct(d.pooled) : '—'}</dd></div><div><dt>Executable price</dt><dd>{cents(d.side === 'no' ? askNo : askYes)}</dd></div><div><dt>Edge</dt><dd className={finite(d.edge) ? (d.edge > 0 ? 'yes' : 'no') : ''}>{finite(d.edge) ? pct(d.edge) : '—'}</dd></div><div><dt>Reserved size</dt><dd>{finite(d.size) ? `$${d.size.toFixed(2)}` : '—'}</dd></div><div><dt>Last stage</dt><dd>{d.stage ?? '—'}{d.ts ? <small className="muted"> · {ago(d.ts)}</small> : null}</dd></div></dl>
      <div className={`cta ${d.stage === 'trade' ? 'yes' : ''}`}>{d.stage === 'trade' ? 'Order submitted' : d.stage === 'skip' ? `Skipped · ${d.reason ?? 'no action'}` : d.stage === 'error' ? 'Agent error · inspect activity' : d.stage === 'approve' ? 'Approval requested' : d.stage === 'decide' ? 'Awaiting approval / order' : 'No decision reported'}</div>
      <p className="muted small">Values come from the buyer agent's telemetry, not from a live order ticket. See docs/guardrails.md.</p>
    </section>
    <section className="panel t-tabs">
      <div className="tabs" role="tablist">{(['purchases', 'scoring', 'rules'] as const).map(t => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t}</button>)}</div>
      {tab === 'purchases' && (purchases.length ? <table className="tbl"><thead><tr><th>Buyer</th><th>Action</th><th>Amount</th><th>Time</th><th>Tx</th></tr></thead><tbody>{purchases.map(e => <tr key={e.id}><td><Address value={String(e.data.buyer)} /></td><td className="yes">Buy read</td><td>${(Number(e.data.amount) / 1e6).toFixed(3)}</td><td className="muted">{ago(e.ts)}</td><td><a href={`https://explorer.solana.com/tx/${e.signature}?cluster=devnet`} target="_blank" rel="noreferrer">↗</a></td></tr>)}</tbody></table> : <Empty title="No purchases">Paid reads recorded with <code>record_purchase</code> appear here. Reads are buyer-reported.</Empty>)}
      {tab === 'scoring' && (events.some(e => e.kind === 'forecast_scored' || e.kind === 'market_resolved') ? events.filter(e => e.kind === 'forecast_scored' || e.kind === 'market_resolved').map(e => <EventLine key={e.id} e={e} />) : <Empty title="Not scored yet">After Gemini settles the contract, the resolver mirrors the outcome and every revealed forecast is Brier-scored on-chain.</Empty>)}
      {tab === 'rules' && <div className="rules"><p>Forecasters commit <code>sha256(prob_bps ‖ salt)</code> on-chain; the probability is sold per read via x402 in devnet USDC.</p><p>Resolution mirrors Gemini's <code>resolutionSide</code> for <code>{symbol}</code>. Anyone holding a paid reveal can call <code>reveal_and_score</code>.</p><p>Score: <code>brier_bps = (prob_bps − outcome·10000)² / 10000</code>; reputation = <code>10000 − mean(brier_bps)</code>. Lower Brier is better.</p><p>Experimental research on devnet. Not investment advice.</p></div>}
    </section>
  </div>;
}

export function Forecasters({ rows }: { rows: LeaderboardRow[] }) {
  return <section className="panel"><div className="panel-title">Forecasters <span className="count">{rows.length}</span></div>{rows.length ? <table className="tbl wide"><thead><tr><th>#</th><th>Forecaster</th><th>Authority</th><th>Reputation</th><th>Scored</th><th>Reads</th><th>Earned USDC</th></tr></thead><tbody>{rows.map((r, i) => <tr key={r.forecasterPda}><td className="muted">{String(i + 1).padStart(2, '0')}</td><td><b>{r.name}</b></td><td><Address value={r.authority} /></td><td><span className="rep">{pct(r.reputationBps / 10000)}</span><Bar value={r.reputationBps / 10000} tone="yes" /><small className="muted">{r.scoredCount ? 'from settled markets' : 'unscored baseline'}</small></td><td>{r.scoredCount}</td><td>{r.totalReads}</td><td>${r.earnedUsdc.toFixed(2)}</td></tr>)}</tbody></table> : <Empty title="No forecasters registered" />}<p className="muted small">Reads are buyer-reported; earned USDC is derived from confirmed token-balance changes.</p></section>;
}

export function Activity({ snap, query }: { snap: Snapshot; query: string }) {
  const q = query.trim().toLowerCase();
  const events = q ? snap.events.filter(e => (symbolOf(e) ?? '').toLowerCase().includes(q)) : snap.events;
  const telemetry = q ? snap.telemetry.filter(t => (symbolOf(t) ?? '').toLowerCase().includes(q)) : snap.telemetry;
  return <div className="two"><section className="panel"><div className="panel-title">Program events <span className="count">{events.length}</span></div>{events.length ? events.map(e => <EventLine key={e.id} e={e} />) : <Empty title="No program events" />}</section><section className="panel"><div className="panel-title">Agent telemetry <span className="count">{telemetry.length}</span></div>{telemetry.length ? telemetry.map((t, i) => <TelemetryLine key={i} t={t} />) : <Empty title="Waiting for agent activity">Nothing is simulated.</Empty>}</section></div>;
}
