import React from 'react';
import type { MarketDetail } from '@delphi/shared';
import { cents, clock, finite } from './api.js';

const W = 640, H = 260, PAD = { l: 8, r: 52, t: 12, b: 24 };
/** Line chart of sampled Yes mid price with optional pooled-forecast reference line. */
export function PriceChart({ prices, pooled, windowMs }: { prices: MarketDetail['prices']; pooled?: number; windowMs?: number }) {
  const cutoff = windowMs ? Date.now() - windowMs : -Infinity;
  const pts = prices.filter(p => finite(p.mid) && p.ts >= cutoff) as { ts: number; mid: number }[];
  if (pts.length < 2) return <div className="chart empty-chart"><span>{prices.length ? 'Not enough samples in this window' : 'Quotes accumulate while the indexer watches this market'}</span></div>;
  const values = pts.map(p => p.mid).concat(finite(pooled) ? [pooled] : []);
  let lo = Math.min(...values), hi = Math.max(...values);
  if (hi - lo < 0.04) { lo = Math.max(0, lo - 0.02); hi = Math.min(1, hi + 0.02); }
  const x = (ts: number) => PAD.l + ((ts - pts[0].ts) / Math.max(1, pts[pts.length - 1].ts - pts[0].ts)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)} ${y(p.mid).toFixed(1)}`).join(' ');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => lo + (hi - lo) * f);
  const last = pts[pts.length - 1];
  const start = pts[0].ts, end = last.ts;
  const labels = end - start < 600000 ? [start, end] : [start, (start + end) / 2, end];
  return <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Yes price from ${cents(pts[0].mid)} to ${cents(last.mid)}`}>
    {ticks.map(v => <g key={v}><line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="grid" /><text x={W - PAD.r + 8} y={y(v) + 4} className="axis">{cents(v)}</text></g>)}
    {finite(pooled) && <g><line x1={PAD.l} x2={W - PAD.r} y1={y(pooled)} y2={y(pooled)} className="pooled" /><text x={W - PAD.r + 8} y={y(pooled) - 6} className="axis pooled-label">pool {cents(pooled)}</text></g>}
    <path d={d} className="series" />
    <circle cx={x(last.ts)} cy={y(last.mid)} r={3.5} className="dot" />
    <rect x={W - PAD.r + 4} y={y(last.mid) - 9} width={44} height={18} rx={3} className="tag" /><text x={W - PAD.r + 26} y={y(last.mid) + 4} className="tag-text" textAnchor="middle">{cents(last.mid)}</text>
    {labels.map((ts, i) => <text key={i} x={x(ts)} y={H - 6} className="axis" textAnchor={i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'}>{clock(ts)}</text>)}
  </svg>;
}
