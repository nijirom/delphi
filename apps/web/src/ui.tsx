import React from 'react';
import { type AgentTelemetry, type IndexerEvent, type MarketSummary, addrHref, ago, cents, clock, finite, marketHref, short, symbolOf, text, txHref, until } from './api.js';

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return <div className="empty"><span aria-hidden="true">◇</span><h3>{title}</h3>{children && <p>{children}</p>}</div>;
}
export function Icon({ category }: { category: string | null }) {
  const glyph = { Crypto: '◈', Sports: '◉', Politics: '◆', Economics: '◇', Finance: '◇', Tech: '◫' }[category ?? ''] ?? '◌';
  return <span className="icon" aria-hidden="true">{glyph}</span>;
}
export function Bar({ value, tone = 'yes' }: { value: number | null; tone?: 'yes' | 'no' | 'pool' }) {
  return <span className={`bar ${tone}`}><span style={{ width: `${Math.round(Math.min(1, Math.max(0, value ?? 0)) * 100)}%` }} /></span>;
}
export function OutcomeRow({ label, price, meta, tone }: { label: string; price: number | null; meta?: string; tone: 'yes' | 'no' }) {
  return <div className={`outcome ${tone}`}><span className="label">{label}</span>{meta && <span className="meta">{meta}</span>}<span className="price">{cents(price)}</span><Bar value={price} tone={tone} /></div>;
}
export function isLiveMarket(m: MarketSummary): boolean {
  return !m.resolved && m.geminiStatus === 'active' && Date.parse(m.expiryDate ?? '') > Date.now();
}
export function QuoteAge({ m }: { m: MarketSummary }) {
  const ts = m.quoteUpdatedAt;
  if (!finite(ts)) return <span className="quote-age">Quote not yet observed</span>;
  const stale = Date.now() - ts > 120000;
  return <span className={`quote-age${stale ? ' stale' : ''}`} title={`Gemini quote fetched ${new Date(ts).toISOString()}`}>{isLiveMarket(m) ? 'Quote' : 'Last quote'} · {ago(ts)}{stale ? ' · stale' : ''}</span>;
}
export function Status({ m }: { m: MarketSummary }) {
  if (m.resolved) return <span className={`badge ${m.outcomeYes === true ? 'yes' : m.outcomeYes === false ? 'no' : ''}`}>Resolved{m.outcomeYes === null ? '' : m.outcomeYes ? ' YES' : ' NO'}</span>;
  if (m.geminiStatus && m.geminiStatus !== 'active') return <span className="badge">Gemini {m.geminiStatus} · not resolved on-chain</span>;
  if (Date.parse(m.expiryDate ?? '') <= Date.now()) return <span className="badge">Expired · awaiting resolution</span>;
  if (!isLiveMarket(m)) return <span className="badge">{m.geminiStatus === 'active' ? 'Expiry unknown' : 'Status unknown'}</span>;
  return <span className="badge live">{until(m.expiryDate)}</span>;
}
export function MarketCard({ m }: { m: MarketSummary }) {
  const yes = m.quote.mid, no = finite(yes) ? 1 - yes : null;
  return <a className="card market" href={marketHref(m.instrumentSymbol)}>
    <div className="card-head"><Icon category={m.category} /><div><h3>{m.title ?? m.instrumentSymbol}</h3><span className="sym">{m.instrumentSymbol}</span></div></div>
    <OutcomeRow label="Yes" price={yes} meta={`${m.reads} reads`} tone="yes" />
    <OutcomeRow label="No" price={no} meta={`${m.forecasts} forecasts`} tone="no" />
    <QuoteAge m={m} />
    <div className="card-foot"><Status m={m} /><span className="muted">{m.revealed}/{m.forecasts} scored</span></div>
  </a>;
}
export function MarketListRow({ m }: { m: MarketSummary }) {
  return <a className="list-row" href={marketHref(m.instrumentSymbol)}><Icon category={m.category} /><span className="title">{m.title ?? m.instrumentSymbol}<small>{m.instrumentSymbol}</small></span><span className="list-price"><span className="price yes">{cents(m.quote.mid)}</span><QuoteAge m={m} /></span><span>{m.forecasts} fc</span><span>{m.reads} reads</span><Status m={m} /></a>;
}
export function Purchase({ e, dense = false }: { e: IndexerEvent; dense?: boolean }) {
  const buyer = text(e.data.buyer) ? short(e.data.buyer) : 'buyer', amount = text(e.data.amount) || finite(e.data.amount) ? Number(e.data.amount) / 1e6 : null;
  return <div className="trade"><span className="who">{buyer}</span><span className="side yes">Buy</span><span>{amount !== null ? `$${amount.toFixed(amount < 0.01 ? 4 : 2)}` : '—'}</span>{!dense && <span className="muted">{symbolOf(e) ?? ''}</span>}<span className="muted">{clock(e.ts)}</span><a href={txHref(e.signature)} target="_blank" rel="noreferrer" aria-label="View transaction">↗</a></div>;
}
export function EventLine({ e }: { e: IndexerEvent }) {
  const sym = symbolOf(e);
  const summary = e.kind === 'forecast_scored' && finite(e.data.probBps) ? `prob ${(e.data.probBps / 100).toFixed(1)}% · brier ${e.data.brierBps} · rep ${((e.data.reputationBps as number) / 100).toFixed(2)}%`
    : e.kind === 'market_resolved' ? `outcome ${e.data.outcomeYes ? 'YES' : 'NO'}`
    : e.kind === 'purchase_recorded' ? `read purchased · $${(Number(e.data.amount) / 1e6).toFixed(2)}`
    : e.kind === 'usdc_transfer' ? `+$${Number(e.data.amountUsdc).toFixed(2)} USDC to ${short(String(e.data.owner))}`
    : 'commitment posted';
  return <div className="line"><span className={`pill k-${e.kind}`}>{e.kind.replaceAll('_', ' ')}</span>{sym ? <a href={marketHref(sym)} className="sym">{sym}</a> : <span className="muted">unenriched</span>}<span className="detail">{summary}</span><span className="muted">{ago(e.ts)}</span><a href={txHref(e.signature)} target="_blank" rel="noreferrer" aria-label="View transaction">↗</a></div>;
}
export function TelemetryLine({ t }: { t: AgentTelemetry }) {
  const sym = symbolOf(t);
  const reason = text(t.detail.reason) ? t.detail.reason.replaceAll('_', ' ') : undefined;
  const nums = (['probability', 'edge', 'size', 'reservedUsdc'] as const).filter(k => finite(t.detail[k])).map(k => `${k} ${k === 'edge' || k === 'probability' ? ((t.detail[k] as number) * 100).toFixed(1) + '%' : '$' + (t.detail[k] as number).toFixed(2)}`);
  return <div className="line"><span className={`pill s-${t.stage}`}>{t.stage}</span>{sym ? <a href={marketHref(sym)} className="sym">{sym}</a> : <span className="muted">all markets</span>}<span className="detail">{[reason, ...nums, text(t.detail.side) ? `side ${t.detail.side}` : undefined].filter(Boolean).join(' · ') || '—'}</span><span className="muted">{ago(t.ts)}</span></div>;
}
export function Address({ value }: { value: string }) { return <a className="addr" href={addrHref(value)} target="_blank" rel="noreferrer">{short(value)} ↗</a>; }
