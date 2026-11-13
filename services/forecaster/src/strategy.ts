import { probabilityAbove } from '@delphi/shared';
import type { Signal } from './signal.js';

export const slugs = ['quant', 'momentum', 'contrarian'] as const;
export type Slug = typeof slugs[number];
export type Forecast = { probBps: number; rationale: string };

/**
 * `quant` is the only persona with information the market does not already encode: spot and realized vol from Gemini's
 * spot venue against the contract strike. It abstains (null) without a strike or feed. `momentum` and `contrarian` are
 * mid-derived baselines kept so scoring has something to rank quant against.
 */
export function forecast(slug: Slug, mid: number, previous: number | null, signal: Signal | null): Forecast | null {
  if (!Number.isFinite(mid) || mid <= 0 || mid >= 1) throw new Error('Invalid market midpoint');
  if (previous !== null && (!Number.isFinite(previous) || previous <= 0 || previous >= 1)) throw new Error('Invalid previous midpoint');
  let probability: number;
  let explanation: string;
  if (slug === 'quant') {
    if (!signal) return null;
    probability = probabilityAbove(signal.spot, signal.strike, signal.sigmaPerMinute, signal.minutes);
    explanation = `Driftless lognormal P(spot >= strike) from Gemini ${signal.spotSymbol} spot ${signal.spot} vs strike ${signal.strike}, realized 1m vol ${(signal.sigmaPerMinute * 100).toFixed(4)}%/min over ${signal.volWindow} candles, ${signal.minutes.toFixed(1)} min to expiry. Ignores the market price entirely.`;
  } else if (slug === 'momentum') {
    const slope = previous === null ? 0 : mid - previous;
    probability = mid + Math.max(-0.05, Math.min(0.05, slope * 0.5));
    explanation = previous === null ? 'No prior observed midpoint; using market midpoint.' : 'Extrapolates half the change from an observed midpoint 1–15 minutes ago, capped at five probability points.';
  } else {
    probability = mid * 0.8 + 0.5 * 0.2;
    explanation = 'Shrinks the market midpoint twenty percent toward one half.';
  }
  return { probBps: Math.round(Math.max(0.01, Math.min(0.99, probability)) * 10000), rationale: `Experimental mechanical strategy, not independently validated. ${explanation}` };
}
