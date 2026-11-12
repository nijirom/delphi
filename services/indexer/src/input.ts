import { createHash, timingSafeEqual } from 'node:crypto';

export type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } };
export type Row = { signature: string; slot: number; blockTime: number | null; logMessages: string[]; err: unknown; accountKeys: unknown[]; preTokenBalances: TokenBalance[]; postTokenBalances: TokenBalance[] };
type Obj = Record<string, unknown>;
function object(x: unknown): x is Obj { return x !== null && typeof x === 'object' && !Array.isArray(x); }
function balances(x: unknown): TokenBalance[] {
  if (x === undefined || x === null) return [];
  if (!Array.isArray(x)) throw new Error('Invalid token balances');
  return x.map(v => {
    if (!object(v) || !Number.isSafeInteger(v.accountIndex) || Number(v.accountIndex) < 0 || typeof v.mint !== 'string' || !object(v.uiTokenAmount) || typeof v.uiTokenAmount.amount !== 'string' || !/^\d+$/.test(v.uiTokenAmount.amount) || !Number.isInteger(v.uiTokenAmount.decimals) || (v.owner !== undefined && typeof v.owner !== 'string')) throw new Error('Invalid token balance');
    return v as unknown as TokenBalance;
  });
}
/** Accepted envelopes: filtered rows, RPC block arrays, or {data: [...]}. */
export function normalizePayload(input: unknown): Row[] {
  const rows: Row[] = [];
  function visit(value: unknown, slot?: number, blockTime?: number | null, depth = 0): void {
    if (depth > 8) throw new Error('Payload nesting exceeds limit');
    if (Array.isArray(value)) { for (const x of value) visit(x, slot, blockTime, depth + 1); return; }
    if (!object(value)) throw new Error('Expected transaction or block object');
    if ('data' in value && !('signature' in value) && !('transaction' in value)) { visit(value.data, slot, blockTime, depth + 1); return; }
    const s = value.slot ?? slot;
    const time = value.blockTime ?? blockTime ?? null;
    if (!Number.isSafeInteger(s) || Number(s) < 0 || (time !== null && !Number.isSafeInteger(time))) throw new Error('Invalid slot or blockTime');
    if ('transactions' in value) {
      if (!Array.isArray(value.transactions)) throw new Error('Expected transactions array');
      visit(value.transactions, Number(s), time as number | null, depth + 1); return;
    }
    let signature: unknown, logs: unknown, err: unknown, keys: unknown, pre: unknown, post: unknown;
    if ('signature' in value) {
      if (!('err' in value)) throw new Error('Filtered rows require err');
      ({ signature, logMessages: logs, err, accountKeys: keys, preTokenBalances: pre, postTokenBalances: post } = value);
    } else {
      if (!object(value.transaction) || !object(value.meta) || !('err' in value.meta)) throw new Error('Transaction requires metadata');
      const tx = value.transaction;
      signature = Array.isArray(tx.signatures) ? tx.signatures[0] : undefined;
      logs = value.meta.logMessages ?? []; err = value.meta.err;
      keys = object(tx.message) ? tx.message.accountKeys : [];
      pre = value.meta.preTokenBalances; post = value.meta.postTokenBalances;
    }
    if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature) || !Array.isArray(logs) || !logs.every(x => typeof x === 'string') || !Array.isArray(keys)) throw new Error('Invalid transaction shape');
    rows.push({ signature, slot: Number(s), blockTime: time as number | null, logMessages: logs as string[], err, accountKeys: keys, preTokenBalances: balances(pre), postTokenBalances: balances(post) });
    if (rows.length > 10000) throw new Error('Too many transactions');
  }
  visit(input);
  return rows;
}
export function authorized(expected: string, actual: unknown): boolean {
  if (!expected.trim() || expected === 'change-me' || typeof actual !== 'string') return false;
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(expected), digest(actual));
}
export function eventKind(name: string): string | undefined {
  return ({ forecastposted: 'forecast_posted', purchaserecorded: 'purchase_recorded', marketresolved: 'market_resolved', forecastscored: 'forecast_scored' } as Record<string, string>)[name.replaceAll('_', '').toLowerCase()];
}
export function tokenReceipts(row: Row, mint: string, owners: ReadonlySet<string>): { owner: string; amount: bigint }[] {
  const totals = new Map<string, bigint>();
  for (const [balances, sign] of [[row.preTokenBalances, -1n], [row.postTokenBalances, 1n]] as const) {
    for (const b of balances) {
      // Missing owners are not guessed: attribution must be backed by RPC metadata.
      if (b.mint !== mint || b.uiTokenAmount.decimals !== 6 || !b.owner || !owners.has(b.owner)) continue;
      totals.set(b.owner, (totals.get(b.owner) ?? 0n) + sign * BigInt(b.uiTokenAmount.amount));
    }
  }
  return [...totals].filter(([, amount]) => amount > 0n).map(([owner, amount]) => ({ owner, amount }));
}
const stages = new Set(['scan', 'buy', 'aggregate', 'decide', 'approve', 'trade', 'skip', 'error']);
export function telemetry(input: unknown): { ts: number; stage: string; instrumentSymbol?: string; detail: Obj } {
  if (!object(input) || !Number.isSafeInteger(input.ts) || Number(input.ts) < 0 || typeof input.stage !== 'string' || !stages.has(input.stage) || !object(input.detail) || (input.instrumentSymbol !== undefined && (typeof input.instrumentSymbol !== 'string' || Buffer.byteLength(input.instrumentSymbol) > 64))) throw new Error('Invalid telemetry');
  function safe(x: unknown, depth = 0): void {
    if (depth > 8) throw new Error('Telemetry nesting exceeds limit');
    if (Array.isArray(x)) { for (const v of x) safe(v, depth + 1); }
    else if (object(x)) for (const [k, v] of Object.entries(x)) {
      if (/secret|password|private|keypair|authorization|api.?key|salt|payment.signature/i.test(k)) throw new Error('Sensitive telemetry field');
      safe(v, depth + 1);
    }
  }
  if (JSON.stringify(input).length > 16384) throw new Error('Telemetry too large');
  safe(input.detail);
  return { ts: Number(input.ts), stage: input.stage, ...(input.instrumentSymbol ? { instrumentSymbol: String(input.instrumentSymbol) } : {}), detail: input.detail };
}
