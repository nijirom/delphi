function finite(n: number): void { if (!Number.isFinite(n)) throw new RangeError('Expected finite number'); }
export function clampProb(p: number, eps = 0.01): number {
  finite(p); finite(eps);
  if (eps <= 0 || eps >= 0.5) throw new RangeError('eps must be in (0, 0.5)');
  return Math.min(1 - eps, Math.max(eps, p));
}
export function logit(p: number): number { const q = clampProb(p); return Math.log(q / (1 - q)); }
export function sigmoid(x: number): number { return x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x)); }
export function pooledForecast(items: { prob: number; reputationBps: number }[]): { prob: number; weightSum: number } {
  let weightSum = 0, sum = 0;
  for (const item of items) {
    finite(item.reputationBps); finite(item.prob);
    if (item.prob < 0 || item.prob > 1 || item.reputationBps < 0 || item.reputationBps > 10000) throw new RangeError('Invalid forecast');
    const w = Math.max(item.reputationBps - 4000, 0) / 6000 + 0.05;
    weightSum += w; sum += w * logit(item.prob);
  }
  return { prob: weightSum ? sigmoid(sum / weightSum) : NaN, weightSum };
}
export function brierBps(probBps: number, outcomeYes: boolean): number {
  if (!Number.isInteger(probBps) || probBps < 0 || probBps > 10000) throw new RangeError('Invalid probability basis points');
  return Math.floor((probBps - (outcomeYes ? 10000 : 0)) ** 2 / 10000);
}
export function edge(pooled: number, marketYesPrice: number): { side: 'yes' | 'no'; edge: number } {
  for (const n of [pooled, marketYesPrice]) { finite(n); if (n < 0 || n > 1) throw new RangeError('Invalid probability'); }
  return { side: pooled > marketYesPrice ? 'yes' : 'no', edge: Math.abs(pooled - marketYesPrice) };
}
export function kellyFraction(p: number, price: number, cap: number): number {
  for (const n of [p, price, cap]) finite(n);
  if (p < 0 || p > 1 || price <= 0 || price >= 1 || cap < 0 || cap > 1) throw new RangeError('Invalid Kelly inputs');
  return Math.min(cap, Math.max(0, (p - price) / (1 - price)));
}
/** Standard normal CDF via Abramowitz–Stegun 7.1.26 (|error| < 1.5e-7). */
export function normalCdf(x: number): number {
  finite(x);
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const tail = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI) * poly;
  return x >= 0 ? 1 - tail : tail;
}
/** Per-minute realized volatility: sample standard deviation of log returns over consecutive closes. */
export function realizedVolPerMinute(closes: number[]): number {
  if (closes.length < 2) throw new RangeError('Need at least two closes');
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    finite(closes[i]); if (closes[i] <= 0 || closes[i - 1] <= 0) throw new RangeError('Closes must be positive');
    returns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  return Math.sqrt(variance);
}
/** P(S_T >= strike) under driftless lognormal diffusion; sigma is per-minute, horizon in minutes. */
export function probabilityAbove(spot: number, strike: number, sigmaPerMinute: number, minutes: number): number {
  for (const n of [spot, strike, sigmaPerMinute, minutes]) finite(n);
  if (spot <= 0 || strike <= 0 || sigmaPerMinute < 0 || minutes <= 0) throw new RangeError('Invalid diffusion inputs');
  const sigma = Math.max(sigmaPerMinute, 1e-6) * Math.sqrt(minutes);
  return normalCdf((Math.log(spot / strike) - sigma * sigma / 2) / sigma);
}
