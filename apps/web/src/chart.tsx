import React, { useState } from 'react';
import type { MarketDetail } from '@delphi/shared';
import { cents, clock, finite } from './api.js';

const W = 640, H = 260, PAD = { l: 8, r: 52, t: 12, b: 24 };
/** Line chart of sampled Yes mid price with optional pooled-forecast reference line. */
export function PriceChart({ prices, pooled, windowMs }: { prices: MarketDetail['prices']; pooled?: number; windowMs?: number }) {
  const [sample, setSample] = useState<number | undefined>();
  const cutoff = windowMs ? Date.now() - windowMs : -Infinity;
  const pts = prices.filter(p => finite(p.mid) && finite(p.ts) && p.ts >= cutoff) as { ts: number; mid: number; bid: number | null; ask: number | null }[];
  if (pts.length < 1) return <div className="chart empty-chart"><span>{prices.length ? 'Not enough samples in this window' : 'Quotes accumulate while the indexer watches this market'}</span></div>;
  const series = pts.length === 1 ? [pts[0], { ...pts[0], ts: pts[0].ts + 1 }] : pts;
  let lo = finite(pooled) ? pooled : series[0].mid, hi = lo;
  for (const p of series) { lo = Math.min(lo, p.mid); hi = Math.max(hi, p.mid); }
  if (hi - lo < 0.04) { lo = Math.max(0, lo - 0.02); hi = Math.min(1, hi + 0.02); }
  const x = (ts: number) => PAD.l + ((ts - series[0].ts) / Math.max(1, series[series.length - 1].ts - series[0].ts)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const d = series.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)} ${y(p.mid).toFixed(1)}`).join(' ');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => lo + (hi - lo) * f);
  const last = series[series.length - 1];
  const start = series[0].ts, end = last.ts;
  const spansDates = new Date(start).toDateString() !== new Date(end).toDateString();
  const spansYears = new Date(start).getFullYear() !== new Date(end).getFullYear();
  const labels = spansDates || end - start < 600000 ? [start, end] : [start, (start + end) / 2, end];
  const selected = Math.min(sample ?? pts.length - 1, pts.length - 1);
  const inspected = pts[selected];
  const ix = pts.length === 1 ? x(last.ts) : x(inspected.ts);
  return <>
  <svg className="chart" tabIndex={0} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Sampled Yes mid price from ${cents(pts[0].mid)} on ${new Date(pts[0].ts).toLocaleString()} to ${cents(last.mid)} on ${new Date(pts[pts.length - 1].ts).toLocaleString()}`} onKeyDown={e => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); setSample(Math.max(0, selected - 1)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setSample(Math.min(pts.length - 1, selected + 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setSample(0); }
    else if (e.key === 'End') { e.preventDefault(); setSample(pts.length - 1); }
    else if (e.key === 'Escape') { e.preventDefault(); setSample(undefined); }
  }} onPointerMove={e => {
    const rect = e.currentTarget.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / Math.max(1, rect.width)) * W;
    const ratio = Math.min(1, Math.max(0, (svgX - PAD.l) / (W - PAD.l - PAD.r)));
    const targetTs = start + ratio * (end - start);
    let best = 0;
    for (let i = 1; i < pts.length; i++) {
      if (Math.abs(pts[i].ts - targetTs) <= Math.abs(pts[best].ts - targetTs)) best = i;
    }
    setSample(best);
  }} onPointerLeave={() => setSample(undefined)}>
    {ticks.map(v => <g key={v}><line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="grid" /><text x={W - PAD.r + 8} y={y(v) + 4} className="axis">{cents(v)}</text></g>)}
    {finite(pooled) && <g><line x1={PAD.l} x2={W - PAD.r} y1={y(pooled)} y2={y(pooled)} className="pooled" /><text x={W - PAD.r + 8} y={y(pooled) - 6} className="axis pooled-label">pool {cents(pooled)}</text></g>}
    <path d={d} className="series" />
    <circle cx={x(last.ts)} cy={y(last.mid)} r={3.5} className="dot" />
    {sample !== undefined && <><line x1={ix} x2={ix} y1={PAD.t} y2={H - PAD.b} className="crosshair" /><circle cx={ix} cy={y(inspected.mid)} r={4} className="sample-dot" /></>}
    <rect x={W - PAD.r + 4} y={y(last.mid) - 9} width={44} height={18} rx={3} className="tag" /><text x={W - PAD.r + 26} y={y(last.mid) + 4} className="tag-text" textAnchor="middle">{cents(last.mid)}</text>
    {labels.map((ts, i) => <text key={i} x={x(ts)} y={H - 6} className="axis" textAnchor={i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'}>{spansDates ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', ...(spansYears ? { year: 'numeric' as const } : {}), hour: '2-digit', minute: '2-digit' }) : clock(ts)}</text>)}
  </svg>
  <div className="chart-readout">
    <span>{sample !== undefined ? `Sample ${selected + 1}/${pts.length}` : 'Latest quote'} · {clock(inspected.ts)}</span>
    <span>bid <b>{cents(inspected.bid)}</b> · ask <b>{cents(inspected.ask)}</b> · mid <b>{cents(inspected.mid)}</b></span>
  </div>
  </>;
}
