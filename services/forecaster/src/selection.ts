import { midPrice, type GeminiContract, type GeminiEvent } from '@delphi/shared';

export type Candidate = { event: GeminiEvent; contract: GeminiContract; mid: number; expiry: number };

const MIN_TTL_MS = 120000;
const MAX_TTL_MS = 86400000;

/**
 * Markets to forecast this poll. Every outcome of a categorical event is its own yes/no contract, so binary and
 * categorical events both qualify; each event contributes its most uncertain contract (mid closest to 0.5), because
 * the outcomes of one event are mutually exclusive and forecasting several of them repeats one question.
 * Categories take turns, each in expiry order, so the repeating 5-minute crypto contracts cannot fill every slot.
 */
export function selectMarkets(events: GeminiEvent[], now: number, count: number): Candidate[] {
  const byCategory = new Map<string, Candidate[]>();
  for (const event of events) {
    if (event.status.toLowerCase() !== 'active' || event.resolvedAt) continue;
    let best: Candidate | null = null;
    for (const contract of event.contracts) {
      const expiry = Date.parse(contract.expiryDate || event.expiryDate || '');
      const mid = midPrice(contract);
      if (contract.status.toLowerCase() !== 'active' || contract.resolutionSide !== null || !Number.isFinite(expiry)
        || expiry < now + MIN_TTL_MS || expiry > now + MAX_TTL_MS || mid === null || mid <= 0 || mid >= 1) continue;
      if (!best || Math.abs(mid - 0.5) < Math.abs(best.mid - 0.5)) best = { event, contract, mid, expiry };
    }
    if (!best) continue;
    const list = byCategory.get(event.category) ?? [];
    list.push(best);
    byCategory.set(event.category, list);
  }
  const queues = [...byCategory.values()].map(list => list.sort((a, b) => a.expiry - b.expiry));
  queues.sort((a, b) => a[0]!.expiry - b[0]!.expiry);
  const selected: Candidate[] = [];
  for (let round = 0; selected.length < count && queues.some(q => round < q.length); round++) {
    for (const queue of queues) {
      if (selected.length === count) break;
      const next = queue[round];
      if (next) selected.push(next);
    }
  }
  return selected;
}
