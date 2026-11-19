import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Row } from './input.js';
export type NewEvent = { kind: string; data: Record<string, unknown> };
export type StoredEvent = NewEvent & { id: number; signature: string; slot: number; ts: number };
export type Snapshot = { forecasterPda: string; authority: string; name: string; reputationBps: number; scoredCount: number; totalReads: number };
export class Store {
  readonly db: Database.Database;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL'); this.db.pragma('busy_timeout = 5000'); this.db.pragma('synchronous = FULL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS transactions(signature TEXT PRIMARY KEY, slot INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, signature TEXT NOT NULL, event_index INTEGER NOT NULL, slot INTEGER NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(signature,event_index));
      CREATE INDEX IF NOT EXISTS events_kind_id ON events(kind,id);
      CREATE INDEX IF NOT EXISTS events_symbol_id ON events(json_extract(data, '$.instrumentSymbol'), id);
      CREATE TABLE IF NOT EXISTS telemetry(id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS telemetry_symbol_id ON telemetry(json_extract(data, '$.instrumentSymbol'), id);
      CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS forecasters(pda TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS earnings(owner TEXT PRIMARY KEY, amount TEXT NOT NULL);`);
    // Version 2 stops treating every incoming owner balance delta as forecast revenue.
    // Rebuild once so balances credited by older releases (including bond refunds and
    // unrelated transfers) cannot survive the accounting cutover.
    const accountingVersion = (this.db.prepare("SELECT value FROM state WHERE key='earningsAccountingVersion'").get() as { value: string } | undefined)?.value;
    if (accountingVersion !== '2') this.db.transaction(() => {
      this.db.prepare('DELETE FROM earnings').run();
      const totals = new Map<string, bigint>();
      for (const { data } of this.db.prepare("SELECT data FROM events WHERE kind='usdc_transfer'").all() as { data: string }[]) {
        const value = JSON.parse(data) as Record<string, unknown>;
        if (value.earned !== true || typeof value.owner !== 'string' || typeof value.amountBaseUnits !== 'string' || !/^\d+$/.test(value.amountBaseUnits)) continue;
        totals.set(value.owner, (totals.get(value.owner) ?? 0n) + BigInt(value.amountBaseUnits));
      }
      const insert = this.db.prepare('INSERT INTO earnings VALUES(?,?)');
      for (const [owner, amount] of totals) insert.run(owner, amount.toString());
      this.db.prepare("INSERT INTO state VALUES('earningsAccountingVersion','2') ON CONFLICT(key) DO UPDATE SET value='2'").run();
    })();
  }
  get(key: string): string | undefined { return (this.db.prepare('SELECT value FROM state WHERE key=?').get(key) as { value: string } | undefined)?.value; }
  set(key: string, value: string): void { this.db.prepare('INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  has(signature: string): boolean { return !!this.db.prepare('SELECT 1 FROM transactions WHERE signature=?').get(signature); }
  ingest(row: Row, entries: NewEvent[]): StoredEvent[] {
    return this.db.transaction(() => {
      if (this.has(row.signature)) return [];
      this.db.prepare('INSERT INTO transactions VALUES(?,?)').run(row.signature, row.slot);
      return entries.map((e, i) => {
        const ts = row.blockTime === null ? Date.now() : row.blockTime * 1000;
        const result = this.db.prepare('INSERT INTO events(signature,event_index,slot,ts,kind,data) VALUES(?,?,?,?,?,?)').run(row.signature, i, row.slot, ts, e.kind, JSON.stringify(e.data));
        if (e.kind === 'usdc_transfer' && e.data.earned === true) {
          const owner = String(e.data.owner);
          const old = this.db.prepare('SELECT amount FROM earnings WHERE owner=?').get(owner) as { amount: string } | undefined;
          const amount = (BigInt(old?.amount ?? '0') + BigInt(String(e.data.amountBaseUnits))).toString();
          this.db.prepare('INSERT INTO earnings VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET amount=excluded.amount').run(owner, amount);
        }
        return { ...e, id: Number(result.lastInsertRowid), signature: row.signature, slot: row.slot, ts };
      });
    })();
  }
  snapshot(rows: Snapshot[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM forecasters').run();
      const insert = this.db.prepare('INSERT INTO forecasters VALUES(?,?)');
      for (const row of rows) insert.run(row.forecasterPda, JSON.stringify(row));
      this.set('snapshotAt', String(Date.now()));
    })();
  }
  leaderboard(): (Snapshot & { earnedUsdc: number })[] {
    return (this.db.prepare('SELECT data FROM forecasters').all() as { data: string }[]).map(r => {
      const row = JSON.parse(r.data) as Snapshot;
      const earned = this.db.prepare('SELECT amount FROM earnings WHERE owner=?').get(row.authority) as { amount: string } | undefined;
      return { ...row, earnedUsdc: Number(earned?.amount ?? '0') / 1e6 };
    }).sort((a, b) => Number(b.scoredCount > 0) - Number(a.scoredCount > 0) || b.reputationBps - a.reputationBps || b.scoredCount - a.scoredCount);
  }
  events(limit: number, since: number, kind?: string, symbol?: string): StoredEvent[] {
    const filter = symbol === undefined ? '' : " AND json_extract(data, '$.instrumentSymbol') = ?";
    const params = [since, kind ?? null, kind ?? null, ...(symbol === undefined ? [] : [symbol]), limit];
    const rows = this.db.prepare(`SELECT * FROM events WHERE id>? AND (? IS NULL OR kind=?)${filter} ORDER BY id DESC LIMIT ?`).all(...params) as { id: number; signature: string; slot: number; ts: number; kind: string; data: string }[];
    return rows.map(r => ({ id: r.id, signature: r.signature, slot: r.slot, ts: r.ts, kind: r.kind, data: JSON.parse(r.data) as Record<string, unknown> }));
  }
  addTelemetry(value: unknown): void {
    this.db.prepare('INSERT INTO telemetry(data) VALUES(?)').run(JSON.stringify(value));
    this.db.prepare('DELETE FROM telemetry WHERE id <= (SELECT id FROM telemetry ORDER BY id DESC LIMIT 1 OFFSET 5000)').run();
  }
  telemetry(limit: number, symbol?: string): unknown[] {
    const filter = symbol === undefined ? '' : " WHERE json_extract(data, '$.instrumentSymbol') = ?";
    return (this.db.prepare(`SELECT data FROM telemetry${filter} ORDER BY id DESC LIMIT ?`).all(...(symbol === undefined ? [] : [symbol]), limit) as { data: string }[]).map(r => JSON.parse(r.data) as unknown);
  }
}
