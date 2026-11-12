export const slugs = ['sharp', 'momentum', 'contrarian'] as const;
export type Slug = typeof slugs[number];
export function forecast(slug: Slug, mid: number, previous: number | null): { probBps: number; rationale: string } {
  if (!Number.isFinite(mid) || mid <= 0 || mid >= 1) throw new Error('Invalid market midpoint');
  if (previous !== null && (!Number.isFinite(previous) || previous <= 0 || previous >= 1)) throw new Error('Invalid previous midpoint');
  let probability: number;
  let explanation: string;
  if (slug === 'momentum') {
    const slope = previous === null ? 0 : mid - previous;
    probability = mid + Math.max(-0.05, Math.min(0.05, slope * 0.5));
    explanation = previous === null ? 'No prior observed midpoint; using market midpoint.' : 'Extrapolates half the change from an observed midpoint 1–15 minutes ago, capped at five probability points.';
  } else if (slug === 'contrarian') {
    probability = mid * 0.8 + 0.5 * 0.2;
    explanation = 'Shrinks the market midpoint twenty percent toward one half.';
  } else {
    probability = mid * 0.98 + 0.5 * 0.02;
    explanation = 'Market-following midpoint with two percent shrinkage toward one half; the name sharp is not a performance claim.';
  }
  return { probBps: Math.round(Math.max(0.01, Math.min(0.99, probability)) * 10000), rationale: `Experimental mechanical strategy, not independently validated. ${explanation}` };
}
