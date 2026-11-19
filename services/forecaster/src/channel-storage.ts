import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { PaymentChannelOpenWrite as OpenWrite, PaymentChannelRecord as ChannelRecord, PaymentChannelStorage } from '@x402/svm/upto/facilitator';

type Row = { record: string; revert_token: string };

/**
 * Durable payment-channel records for the facilitator. Without them, a restart forgets every open channel and the
 * rent-cleanup worker can never close an expired one, leaving the payer's escrow stranded. Semantics follow the SDK's
 * InMemoryPaymentChannelStorage: first-writer-wins bindings, forward-only clocks, revert tokens only on creation.
 */
export function sqliteChannelStorage(db: Database.Database): PaymentChannelStorage {
  db.exec(`CREATE TABLE IF NOT EXISTS payment_channels (
    network TEXT NOT NULL, channel_id TEXT NOT NULL, record TEXT NOT NULL, revert_token TEXT NOT NULL,
    PRIMARY KEY (network, channel_id))`);
  const select = db.prepare('SELECT record, revert_token FROM payment_channels WHERE network=? AND channel_id=?');
  const upsert = db.prepare('INSERT INTO payment_channels(network, channel_id, record, revert_token) VALUES(?,?,?,?) ON CONFLICT(network, channel_id) DO UPDATE SET record=excluded.record, revert_token=excluded.revert_token');
  const read = (network: string, channelId: string) => {
    const row = select.get(network, channelId) as Row | undefined;
    return row && { record: JSON.parse(row.record) as ChannelRecord, revertToken: row.revert_token };
  };
  const conflict = (requested: ChannelRecord, stored: ChannelRecord) =>
    (requested.receiverAuthorizer !== '' && stored.receiverAuthorizer !== '' && stored.receiverAuthorizer !== requested.receiverAuthorizer)
    || (requested.callerIdentity !== '' && stored.callerIdentity !== '' && stored.callerIdentity !== requested.callerIdentity);
  const open = db.transaction((record: ChannelRecord): OpenWrite => {
    const existing = read(record.network, record.channelId);
    if (existing && conflict(record, existing.record)) return { record: existing.record, revertToken: '' };
    const token = randomBytes(16).toString('hex');
    if (!existing) { upsert.run(record.network, record.channelId, JSON.stringify(record), token); return { record: { ...record }, revertToken: token }; }
    const stored = { ...existing.record, expiresAt: Math.max(existing.record.expiresAt, record.expiresAt), lastActivityAt: Math.max(existing.record.lastActivityAt, record.lastActivityAt) };
    upsert.run(record.network, record.channelId, JSON.stringify(stored), token);
    return { record: stored, revertToken: '' };
  });
  const revert = db.transaction((write: OpenWrite) => {
    if (!write.revertToken) return;
    const existing = read(write.record.network, write.record.channelId);
    if (existing?.revertToken === write.revertToken) db.prepare('DELETE FROM payment_channels WHERE network=? AND channel_id=?').run(write.record.network, write.record.channelId);
  });
  const activity = db.transaction((records: ChannelRecord[]) => {
    for (const record of records) {
      const existing = read(record.network, record.channelId);
      if (!existing) { upsert.run(record.network, record.channelId, JSON.stringify(record), ''); continue; }
      const stored = { ...existing.record, lastActivityAt: Math.max(existing.record.lastActivityAt, record.lastActivityAt) };
      upsert.run(record.network, record.channelId, JSON.stringify(stored), existing.revertToken);
    }
  });
  return {
    async recordOpen(record) { return open.immediate(record); },
    async revertOpen(write) { revert.immediate(write); },
    async recordActivity(...records) { activity.immediate(records); },
    async get(network, channelId) { return read(network, channelId)?.record; },
    async list(network) { return (db.prepare('SELECT record FROM payment_channels WHERE network=?').all(network) as { record: string }[]).map(r => JSON.parse(r.record) as ChannelRecord); },
    async delete(network, channelId) { db.prepare('DELETE FROM payment_channels WHERE network=? AND channel_id=?').run(network, channelId); },
  };
}
