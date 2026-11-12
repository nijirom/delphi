import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Reveal = { forecast_pda: string; persona: string; event_ticker: string; instrument_symbol: string; prob_bps: number; salt_hex: string; rationale: string; posted_at: number; tx: string | null };
export function openStore(path: string, readonly = false): Database.Database {
  if (!readonly) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { readonly, fileMustExist: readonly });
  db.pragma('busy_timeout = 5000');
  if (!readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.exec(`CREATE TABLE IF NOT EXISTS reveals (
      forecast_pda TEXT PRIMARY KEY, persona TEXT NOT NULL, event_ticker TEXT NOT NULL,
      instrument_symbol TEXT NOT NULL, prob_bps INTEGER NOT NULL CHECK(prob_bps BETWEEN 0 AND 10000),
      salt_hex TEXT NOT NULL CHECK(length(salt_hex)=64), rationale TEXT NOT NULL,
      posted_at INTEGER NOT NULL, tx TEXT
    );
    CREATE INDEX IF NOT EXISTS reveals_event ON reveals(event_ticker);
    CREATE TABLE IF NOT EXISTS observations (symbol TEXT NOT NULL, ts INTEGER NOT NULL, mid REAL NOT NULL, PRIMARY KEY(symbol,ts));`);
  }
  return db;
}
export function rows(db: Database.Database): Reveal[] {
  return db.prepare('SELECT * FROM reveals ORDER BY posted_at').all() as Reveal[];
}
export function find(db: Database.Database, pda: string): Reveal | undefined {
  return db.prepare('SELECT * FROM reveals WHERE forecast_pda = ?').get(pda) as Reveal | undefined;
}
export function persist(db: Database.Database, r: Reveal): void {
  db.prepare(`INSERT INTO reveals(forecast_pda,persona,event_ticker,instrument_symbol,prob_bps,salt_hex,rationale,posted_at,tx)
    VALUES(@forecast_pda,@persona,@event_ticker,@instrument_symbol,@prob_bps,@salt_hex,@rationale,@posted_at,@tx)`).run(r);
}
