import type Database from 'better-sqlite3';
import { find, persist, type Reveal } from './store.js';
import { PublicationError } from './publishing-protocol.js';

export type HostedPublication = { authority: string; reveal: Reveal };
export type PublishingStore = {
  list(symbol?: string): HostedPublication[];
  find(address: string): HostedPublication | undefined;
  hasNonce(authority: string, nonce: string): boolean;
  publish(row: HostedPublication, nonce: string, expiresAt: number, now: number): void;
};
/** Uses the existing private reveals table so the resolver can score hosted third-party forecasts too. */
export function createPublishingStore(db: Database.Database): PublishingStore {
  db.exec(`CREATE TABLE IF NOT EXISTS publications (
    forecast_pda TEXT PRIMARY KEY REFERENCES reveals(forecast_pda), authority TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS publication_nonces (
    authority TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL,
    PRIMARY KEY(authority, nonce)
  );`);
  const select = db.prepare('SELECT r.*, p.authority FROM publications p JOIN reveals r USING(forecast_pda) WHERE (? IS NULL OR r.instrument_symbol=?) ORDER BY r.posted_at');
  const lookup = db.prepare('SELECT authority FROM publications WHERE forecast_pda=?');
  const nonceLookup = db.prepare('SELECT 1 FROM publication_nonces WHERE authority=? AND nonce=?');
  const insertNonce = db.prepare('INSERT INTO publication_nonces(authority,nonce,expires_at) VALUES(?,?,?)');
  const insert = db.prepare('INSERT INTO publications(forecast_pda,authority) VALUES(?,?)');
  const prune = db.prepare('DELETE FROM publication_nonces WHERE expires_at < ?');
  const publish = db.transaction((row: HostedPublication, nonce: string, expiresAt: number, now: number) => {
    if (nonceLookup.get(row.authority, nonce)) throw new PublicationError(409, 'Publication nonce already used');
    if (find(db, row.reveal.forecast_pda)) throw new PublicationError(409, 'Forecast already hosted; immutable publications cannot be replaced');
    prune.run(now - 30);
    insertNonce.run(row.authority, nonce, expiresAt);
    persist(db, row.reveal);
    insert.run(row.reveal.forecast_pda, row.authority);
  });
  return {
    list(symbol) {
      return (select.all(symbol ?? null, symbol ?? null) as (Reveal & { authority: string })[]).map(({ authority, ...reveal }) => ({ authority, reveal }));
    },
    find(address) {
      const row = lookup.get(address) as { authority: string } | undefined;
      const reveal = row && find(db, address);
      return row && reveal ? { authority: row.authority, reveal } : undefined;
    },
    hasNonce(authority, nonce) { return Boolean(nonceLookup.get(authority, nonce)); },
    publish,
  };
}
