import Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import type { GeminiContract } from '@delphi/shared';

export const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
export const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export function units(value: number | string): number {
  const d = new Decimal(value).mul(1e6);
  if (!d.isFinite() || d.isNegative() || !d.isInteger() || d.gt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid USDC amount');
  return d.toNumber();
}
export function safeUrl(url: string, base: string): string {
  const b = new URL(base), u = new URL(url, b);
  if (u.origin !== b.origin || u.username || u.password || !['http:', 'https:'].includes(u.protocol)) throw new Error('Untrusted forecast URL');
  return u.href;
}
export function orderPlan(c: GeminiContract, probability: number, budget: number, feeBps: number) {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) return null;
  // Missing venue constraints must never be guessed for an executable order.
  if (!c.priceIncrement || !c.quantityIncrement || !c.quantityMinimum || !c.priceMinimum) return null;
  const pi = new Decimal(c.priceIncrement), qi = new Decimal(c.quantityIncrement);
  if (!pi.isPositive() || !qi.isPositive()) return null;
  const candidates: { side: 'yes' | 'no'; price: Decimal; edge: number }[] = [];
  for (const side of ['yes', 'no'] as const) {
    const raw = side === 'yes' ? c.prices.bestAsk : c.prices.bestBid === null ? null : new Decimal(1).minus(c.prices.bestBid).toString();
    if (raw === null) continue;
    const price = new Decimal(raw).div(pi).ceil().mul(pi);
    if (!price.isFinite() || price.lte(0) || price.gte(1) || price.lt(c.priceMinimum)) continue;
    const effective = price.mul(new Decimal(1).plus(new Decimal(feeBps).div(10000)));
    candidates.push({ side, price, edge: new Decimal(side === 'yes' ? probability : 1 - probability).minus(effective).toNumber() });
  }
  const best = candidates.sort((a,b) => b.edge-a.edge)[0];
  if (!best || best.edge <= 0) return null;
  const costPer = best.price.mul(new Decimal(1).plus(new Decimal(feeBps).div(10000)));
  const quantity = new Decimal(budget).div(costPer).div(qi).floor().mul(qi);
  if (quantity.lte(0) || quantity.lt(c.quantityMinimum)) return null;
  const reserve = quantity.mul(costPer).mul(1e6).ceil().toNumber();
  if (!Number.isSafeInteger(reserve)) return null;
  return { side: best.side, price: best.price.toFixed(), quantity: quantity.toFixed(), edge: best.edge, reserve };
}
export type ReadRow = { key: string; symbol: string; payload: string | null; recorded: number; revealed: number };
export class Ledger {
  readonly db: Database.Database;
  constructor(path: string, readonly daily: number, readonly perMarket: number, readonly maxPosition: number) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS reservations (
      kind TEXT NOT NULL, key TEXT NOT NULL, symbol TEXT NOT NULL, day TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK(amount>0), state TEXT NOT NULL DEFAULT 'reserved',
      payload TEXT, recorded INTEGER NOT NULL DEFAULT 0, revealed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(kind,key));`);
  }
  reserve(kind: 'read' | 'trade', key: string, symbol: string, amount: number): boolean {
    if (!Number.isSafeInteger(amount) || amount <= 0) return false;
    return this.db.transaction(() => {
      const day = new Date().toISOString().slice(0,10);
      if (this.has(kind,key)) return false;
      const daily = this.sum('day = ?', day), market = this.sum('symbol = ?', symbol);
      const position = this.sum("symbol = ? AND kind = 'trade'",symbol);
      if (daily + amount > this.daily || market + amount > this.perMarket || (kind === 'trade' && position + amount > this.maxPosition)) return false;
      this.db.prepare('INSERT INTO reservations(kind,key,symbol,day,amount) VALUES(?,?,?,?,?)').run(kind,key,symbol,day,amount);
      return true;
    }).immediate();
  }
  private sum(where: string, arg: string): number { return (this.db.prepare(`SELECT COALESCE(SUM(amount),0) AS n FROM reservations WHERE ${where}`).get(arg) as {n:number}).n; }
  remaining(symbol: string): number { return Math.max(0, Math.min(this.daily-this.sum('day = ?',new Date().toISOString().slice(0,10)),this.perMarket-this.sum('symbol = ?',symbol))); }
  has(kind: string,key: string): boolean { return !!this.db.prepare('SELECT 1 FROM reservations WHERE kind=? AND key=?').get(kind,key); }
  saveRead(key: string,payload: unknown): void { this.db.prepare("UPDATE reservations SET payload=?,state='received' WHERE kind='read' AND key=?").run(JSON.stringify(payload),key); }
  mark(key: string, field: 'recorded'|'revealed'): void { this.db.prepare(`UPDATE reservations SET ${field}=1 WHERE kind='read' AND key=?`).run(key); }
  tradeResult(key: string, orderId: number): void { this.db.prepare("UPDATE reservations SET state='submitted',payload=? WHERE kind='trade' AND key=?").run(JSON.stringify({orderId}),key); }
  reads(): ReadRow[] { return this.db.prepare("SELECT key,symbol,payload,recorded,revealed FROM reservations WHERE kind='read' AND payload IS NOT NULL").all() as ReadRow[]; }
  close(): void { this.db.close(); }
}
