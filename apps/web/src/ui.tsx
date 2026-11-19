import React, { createContext, useContext, useState } from 'react';
import { type AgentTelemetry, type IndexerEvent, type MarketSummary, type Network, explorerHref, ago, cents, clock, finite, marketHref, short, symbolOf, text, until } from './api.js';

export const NetworkContext = createContext<Network | null>(null);
export function ExplorerLink({ kind, value, children, className }: { kind: 'tx' | 'address'; value: string; children?: React.ReactNode; className?: string }) {
  const network = useContext(NetworkContext);
  const [copied, setCopied] = useState(false);
  const href = explorerHref(kind, value, network?.cluster);
  return href
    ? <a className={className} href={href} target="_blank" rel="noreferrer" aria-label={kind === 'tx' ? 'View transaction' : undefined}>{children ?? '↗'}</a>
    : <button type="button" className={`copy-btn${className ? ' ' + className : ''}`} title={`Copy ${value}`} onClick={() => { void navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? 'copied' : (children ?? short(value))}</button>;
}
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
export function OutcomeRow({ label, price, meta, tone, won }: { label: string; price: number | null; meta?: string; tone: 'yes' | 'no'; won?: boolean }) {
  return <div className={`outcome ${tone}${won === true ? ' won' : won === false ? ' lost' : ''}`}>
    <span className="label">{label}{won === true && <span className="won-tag" aria-label="Settled winner"> ✓</span>}</span>
    {meta && <span className="meta">{meta}</span>}<span className="price">{cents(price)}</span><Bar value={price} tone={tone} />
  </div>;
}
export function isLiveMarket(m: MarketSummary): boolean {
  return !m.resolved && m.geminiStatus === 'active' && Date.parse(m.expiryDate ?? '') > Date.now();
}
export function QuoteAge({ m }: { m: MarketSummary }) {
  const ts = m.quoteUpdatedAt;
  if (!finite(ts)) return <span className="quote-age">Quote not yet observed</span>;
  const stale = Date.now() - ts > 120000;
  // A checked-but-empty book is not a quote: saying "last quote" next to an em dash price contradicts itself.
  const kind = !finite(m.quote.mid) ? 'Checked' : isLiveMarket(m) ? 'Quote' : 'Last quote';
  return <span className={`quote-age${stale ? ' stale' : ''}`} title={`Gemini ${finite(m.quote.mid) ? 'quote' : 'book check'} at ${new Date(ts).toISOString()}`}>{kind} · {ago(ts)}{stale ? ' · stale' : ''}</span>;
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
    <OutcomeRow label="Yes" price={yes} meta={m.resolved ? 'last observed' : finite(yes) ? `${Math.round(yes * 100)}% implied` : 'no quote'} tone="yes" won={m.resolved && m.outcomeYes !== null ? m.outcomeYes : undefined} />
    <OutcomeRow label="No" price={no} meta={`${m.forecasts} ${m.forecasts === 1 ? 'forecast' : 'forecasts'}`} tone="no" won={m.resolved && m.outcomeYes !== null ? !m.outcomeYes : undefined} />
    <QuoteAge m={m} />
    <div className="card-foot"><Status m={m} /><span className="muted">{m.forecasts === 0 ? 'no forecasts yet' : `${m.reads} ${m.reads === 1 ? 'read' : 'reads'} · ${m.revealed}/${m.forecasts} scored`}</span></div>
  </a>;
}
export function MarketListRow({ m }: { m: MarketSummary }) {
  return <a className="list-row" href={marketHref(m.instrumentSymbol)}><Icon category={m.category} /><span className="title">{m.title ?? m.instrumentSymbol}<small>{m.instrumentSymbol}</small></span><span className="list-price"><span className="price yes">{cents(m.quote.mid)}</span><QuoteAge m={m} /></span><span>{m.forecasts} fc</span><span>{m.reads} reads</span><Status m={m} /></a>;
}
export function Purchase({ e, dense = false }: { e: IndexerEvent; dense?: boolean }) {
  const buyer = text(e.data.buyer) ? short(e.data.buyer) : 'buyer', amount = text(e.data.amount) || finite(e.data.amount) ? Number(e.data.amount) / 1e6 : null;
  return <div className="trade"><span className="who">{buyer}</span><span className="side yes">Buy</span><span>{amount !== null ? `$${amount.toFixed(amount < 0.01 ? 4 : 2)}` : '—'}</span>{!dense && <span className="muted">{symbolOf(e) ?? ''}</span>}<span className="muted">{clock(e.ts)}</span><ExplorerLink kind="tx" value={e.signature} /></div>;
}
export function EventLine({ e }: { e: IndexerEvent }) {
  const sym = symbolOf(e);
  const summary = e.kind === 'forecast_scored' && e.data.forfeited === true ? `forfeited · never revealed · brier ${e.data.brierBps} · rep ${(Number(e.data.reputationBps) / 100).toFixed(2)}%`
    : e.kind === 'forecast_scored' && finite(e.data.probBps) ? `prob ${(e.data.probBps / 100).toFixed(1)}% · brier ${e.data.brierBps} · rep ${((e.data.reputationBps as number) / 100).toFixed(2)}%`
    : e.kind === 'market_resolved' ? `outcome ${e.data.outcomeYes ? 'YES' : 'NO'}`
    : e.kind === 'purchase_recorded' ? `read purchased · $${(Number(e.data.amount) / 1e6).toFixed(2)}`
    : e.kind === 'usdc_transfer' ? `+$${Number(e.data.amountUsdc).toFixed(2)} USDC to ${short(String(e.data.owner))}`
    : 'commitment posted';
  return <div className="line"><span className={`pill k-${e.kind}`}>{e.kind.replaceAll('_', ' ')}</span>{sym ? <a href={marketHref(sym)} className="sym">{sym}</a> : <span className="muted">unenriched</span>}<span className="detail">{summary}</span><span className="muted">{ago(e.ts)}</span><ExplorerLink kind="tx" value={e.signature} /></div>;
}
export function TelemetryLine({ t }: { t: AgentTelemetry }) {
  const sym = symbolOf(t);
  const reason = t.detail.reason === 'dry_run_no_payments_or_trades' && Array.isArray(t.detail.listings) && t.detail.listings.length > 0
    ? `dry run · ${t.detail.listings.length} ${t.detail.listings.length === 1 ? 'listing' : 'listings'}${finite(t.detail.topReputationBps) ? ` · top rep ${(Number(t.detail.topReputationBps) / 100).toFixed(1)}%` : ''}`
    : text(t.detail.reason) ? t.detail.reason.replaceAll('_', ' ') : undefined;
  const nums = (['probability', 'edge', 'size', 'reservedUsdc'] as const).filter(k => finite(t.detail[k])).map(k => `${k} ${k === 'edge' || k === 'probability' ? ((t.detail[k] as number) * 100).toFixed(1) + '%' : '$' + (t.detail[k] as number).toFixed(2)}`);
  const context = (['operation', 'status'] as const).filter(k => text(t.detail[k])).map(k => (t.detail[k] as string).replaceAll('_', ' '));
  return <div className="line"><span className={`pill s-${t.stage}`}>{t.stage}</span>{sym ? <a href={marketHref(sym)} className="sym">{sym}</a> : <span className="muted">all markets</span>}<span className="detail">{[...context, reason, ...nums, text(t.detail.side) ? `side ${t.detail.side}` : undefined].filter(Boolean).join(' · ') || '—'}</span><span className="muted">{ago(t.ts)}</span></div>;
}
export function Address({ value }: { value: string }) { return <ExplorerLink className="addr" kind="address" value={value}>{short(value)}</ExplorerLink>; }
