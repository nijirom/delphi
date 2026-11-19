import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { PaymentChannelRecord } from '@x402/svm/upto/facilitator';
import { sqliteChannelStorage } from './channel-storage.js';
import { CHANNEL_QUOTE_TTL_MS, MAX_OUTSTANDING_CHANNEL_QUOTES, channelQuoteStore, type ChannelQuote } from './channels.js';

const network = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const record = (over: Partial<PaymentChannelRecord> = {}): PaymentChannelRecord => ({ network, channelId: 'chan', payTo: 'recipient', tokenProgram: 'Tokenkeg', expiresAt: 100, lastActivityAt: 1000, receiverAuthorizer: '', callerIdentity: '', ...over }) as PaymentChannelRecord;
const quote = (n: number, created: number): ChannelQuote => ({
  id: n.toString(16).padStart(64, '0'),
  recipient: 'recipient',
  items: [{ forecastPda: 'forecast-a', amount: 1 }, { forecastPda: 'forecast-b', amount: 1 }],
  requirements: { scheme: 'upto', network, asset: 'mint', amount: '2', payTo: 'recipient', maxTimeoutSeconds: 120, extra: {} },
  created,
});

test('channel records survive a facilitator restart so expired escrow can still be cleaned up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'delphi-channels-')), path = join(dir, 'f.sqlite');
  try {
    let db = new Database(path);
    await sqliteChannelStorage(db).recordOpen(record());
    db.close();
    db = new Database(path);
    assert.equal((await sqliteChannelStorage(db).list(network)).length, 1);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('first writer wins bindings, clocks only move forward, and only the creator can revert', async () => {
  const storage = sqliteChannelStorage(new Database(':memory:'));
  const created = await storage.recordOpen(record({ callerIdentity: 'alice' }));
  assert.notEqual(created.revertToken, '');
  const hijack = await storage.recordOpen(record({ callerIdentity: 'mallory', payTo: 'attacker', expiresAt: 999 }));
  assert.equal(hijack.revertToken, '');
  assert.equal(hijack.record.payTo, 'recipient', 'a conflicting open never rewrites the stored row');
  assert.equal(hijack.record.expiresAt, 100);
  const again = await storage.recordOpen(record({ expiresAt: 50, lastActivityAt: 2000 }));
  assert.equal(again.record.expiresAt, 100, 'expiry never moves backwards');
  assert.equal(again.record.lastActivityAt, 2000);
  await storage.revertOpen(created);
  assert.ok(await storage.get(network, 'chan'), 'a later open rotated the token, so the stale revert is a no-op');
});

test('quote pruning removes only expired or unusable unpaid rows', () => {
  const db = new Database(':memory:');
  const store = channelQuoteStore(db);
  const now = 10 * CHANNEL_QUOTE_TTL_MS;
  const insert = db.prepare('INSERT INTO channel_reads VALUES(?,?)');
  const old = quote(1, now - CHANNEL_QUOTE_TTL_MS - 1);
  const unusable = { ...quote(2, now), created: 'not-a-timestamp' };
  const boundary = quote(3, now - CHANNEL_QUOTE_TTL_MS);
  const fresh = quote(4, now);
  const paid = { ...quote(5, old.created), payment: {} };
  const recoverable = { ...quote(6, old.created), body: { id: quote(6, old.created).id, forecasts: [], amount: '0' } };
  const linked = quote(7, old.created);
  for (const value of [old, unusable, boundary, fresh, paid, recoverable, linked]) insert.run(value.id, JSON.stringify(value));
  insert.run('malformed', '{');
  db.prepare('INSERT INTO channel_payments VALUES(?,?)').run('channel', linked.id);

  assert.equal(store.prune(now), 2);
  const rows = db.prepare('SELECT id FROM channel_reads').all() as { id: string }[];
  const ids = new Set(rows.map(row => row.id));
  assert.deepEqual(ids, new Set([boundary.id, fresh.id, paid.id, recoverable.id, linked.id, 'malformed']));
});

test('distinct unpaid quote creation is capped until an expired slot is pruned', () => {
  const db = new Database(':memory:');
  const store = channelQuoteStore(db);
  const now = 10 * CHANNEL_QUOTE_TTL_MS;
  let accepted = 0;
  for (let n = 0; n < MAX_OUTSTANDING_CHANNEL_QUOTES + 100; n++) {
    if (store.create(quote(n, now), now)) accepted++;
  }
  assert.equal(accepted, MAX_OUTSTANDING_CHANNEL_QUOTES);
  assert.equal(db.prepare('SELECT id FROM channel_reads').all().length, MAX_OUTSTANDING_CHANNEL_QUOTES);

  const expired = store.get(quote(0, now).id)!;
  expired.created = now - CHANNEL_QUOTE_TTL_MS - 1;
  store.save(expired);
  assert.ok(store.create(quote(MAX_OUTSTANDING_CHANNEL_QUOTES + 100, now), now));
  assert.equal(db.prepare('SELECT id FROM channel_reads').all().length, MAX_OUTSTANDING_CHANNEL_QUOTES);
});
