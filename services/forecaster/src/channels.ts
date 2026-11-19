import express, { type Express } from 'express';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import type { Keypair } from '@solana/web3.js';
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { UptoSvmScheme } from '@x402/svm/upto/server';
import { log, type ForecastListing, type PaidForecast } from '@delphi/shared';

export const MAX_CHANNEL_READS = 16;
export const MAX_OUTSTANDING_CHANNEL_QUOTES = 256;
export const CHANNEL_QUOTE_TTL_MS = 120000;
type Item = { forecastPda: string; amount: number };
export type ChannelQuote = { id: string; recipient: string; items: Item[]; requirements: PaymentRequirements; created: number; payment?: PaymentPayload; deposited?: boolean; body?: { id: string; forecasts: PaidForecast[]; amount: string }; settlement?: string };
export type ChannelOptions = {
  db: Database.Database; network: `${string}:${string}`; mint: string; rpcUrl: string; facilitatorUrl: string; authorizer: Keypair;
  listings: () => ForecastListing[];
  /** Rechecks availability AND the on-chain commitment; undefined means unavailable, never billable. */
  deliver: (forecastPda: string) => Promise<PaidForecast | undefined>;
};

/** Paid or partially processed rows are deliberately excluded: they are durable recovery records, not quote spam. */
export function channelQuoteStore(db: Database.Database) {
  db.exec('CREATE TABLE IF NOT EXISTS channel_reads (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS channel_payments (channel TEXT PRIMARY KEY, quote TEXT NOT NULL UNIQUE)');
  const select = db.prepare('SELECT payload FROM channel_reads WHERE id=?');
  const insert = db.prepare('INSERT INTO channel_reads VALUES(?,?)');
  const update = db.prepare('UPDATE channel_reads SET payload=? WHERE id=?');
  const unpaid = `json_valid(payload)=1
    AND CASE WHEN json_valid(payload) THEN json_type(payload, '$.payment') ELSE 'invalid' END IS NULL
    AND CASE WHEN json_valid(payload) THEN json_type(payload, '$.deposited') ELSE 'invalid' END IS NULL
    AND CASE WHEN json_valid(payload) THEN json_type(payload, '$.body') ELSE 'invalid' END IS NULL
    AND CASE WHEN json_valid(payload) THEN json_type(payload, '$.settlement') ELSE 'invalid' END IS NULL
    AND NOT EXISTS (SELECT 1 FROM channel_payments WHERE quote=channel_reads.id)`;
  const prune = db.prepare(`DELETE FROM channel_reads WHERE ${unpaid} AND (
    CASE WHEN json_valid(payload) THEN json_type(payload, '$.created') ELSE 'invalid' END IS NULL
    OR CASE WHEN json_valid(payload) THEN json_type(payload, '$.created') ELSE 'invalid' END NOT IN ('integer','real')
    OR CASE WHEN json_valid(payload) THEN json_extract(payload, '$.created') END < ?)`);
  const count = db.prepare(`SELECT COUNT(*) AS n FROM channel_reads WHERE ${unpaid}`);
  const read = (id: string): ChannelQuote | undefined => {
    const row = select.get(id) as { payload: string } | undefined;
    return row && JSON.parse(row.payload) as ChannelQuote;
  };
  const create = db.transaction((quote: ChannelQuote, now: number): ChannelQuote | undefined => {
    prune.run(now - CHANNEL_QUOTE_TTL_MS);
    const existing = read(quote.id);
    if (existing) return existing;
    const outstanding = count.get() as { n: number };
    if (outstanding.n >= MAX_OUTSTANDING_CHANNEL_QUOTES) return undefined;
    insert.run(quote.id, JSON.stringify(quote));
    return quote;
  });
  return {
    get: read,
    create(quote: ChannelQuote, now = Date.now()) { return create.immediate(quote, now); },
    save(quote: ChannelQuote) {
      if (update.run(JSON.stringify(quote), quote.id).changes !== 1) throw new Error('Channel quote disappeared');
    },
    prune(now = Date.now()) { return prune.run(now - CHANNEL_QUOTE_TTL_MS).changes; },
  };
}
/** One escrow open and one claim for up to sixteen reads from the same recipient.
 * Recovery only resubmits the stored SDK payload; it never signs a replacement payment.
 * The deployment is a single resource-server process owning this SQLite database.
 */
export async function registerChannelRoutes(app: Express, o: ChannelOptions): Promise<void> {
  const quotes = channelQuoteStore(o.db);
  const resource = new x402ResourceServer(new HTTPFacilitatorClient({ url: o.facilitatorUrl }));
  resource.register(o.network, new UptoSvmScheme({ rpcUrl: o.rpcUrl, receiverAuthorizerSigner: await createKeyPairSignerFromBytes(o.authorizer.secretKey), withdrawDelay: 300 }));
  await resource.initialize();
  const get = quotes.get;
  const save = quotes.save;
  const busy = new Set<string>();
  app.get('/channels', (_req, res) => res.json({ scheme: 'upto', version: 1, maxReads: MAX_CHANNEL_READS, quoteUrl: '/channels/quotes', recipientMode: 'single', settlement: 'per-bundle' }));
  app.post('/channels/quotes', express.json({ limit: '8kb' }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { id, forecasts } = req.body ?? {};
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id) || !Array.isArray(forecasts) || forecasts.length < 2 || forecasts.length > MAX_CHANNEL_READS || new Set(forecasts).size !== forecasts.length || forecasts.some(x => typeof x !== 'string')) { res.status(400).json({ error: 'Invalid bundle' }); return; }
      let q = get(id);
      if (q) {
        if (JSON.stringify(q.items.map(x => x.forecastPda)) !== JSON.stringify(forecasts)) { res.status(409).json({ error: 'Quote ID already bound' }); return; }
      } else {
        const live = o.listings(), selected = forecasts.map(id => live.find(x => x.forecastPda === id));
        if (selected.some(x => !x) || new Set(selected.map(x => x!.forecasterAuthority)).size !== 1) { res.status(409).json({ error: 'Bundle unavailable or mixed recipients' }); return; }
        const items = selected.map(x => ({ forecastPda: x!.forecastPda, amount: Math.round(x!.pricePerReadUsdc * 1e6) }));
        if (items.some(x => !Number.isSafeInteger(x.amount) || x.amount <= 0)) throw new Error('Invalid read price');
        const amount = items.reduce((n, x) => n + x.amount, 0);
        const requirements = await resource.buildPaymentRequirements({ scheme: 'upto', network: o.network, payTo: selected[0]!.forecasterAuthority, price: { amount: String(amount), asset: o.mint, extra: { decimals: 6 } }, maxTimeoutSeconds: 120 });
        const created = quotes.create({ id, recipient: selected[0]!.forecasterAuthority, items, requirements: requirements[0]!, created: Date.now() });
        if (!created) { res.status(429).json({ error: 'Too many outstanding channel quotes' }); return; }
        q = created;
        if (JSON.stringify(q.items.map(x => x.forecastPda)) !== JSON.stringify(forecasts)) { res.status(409).json({ error: 'Quote ID already bound' }); return; }
      }
      res.json({ id, url: `/channels/reads/${id}`, recipient: q.recipient, amount: q.requirements.amount, items: q.items });
    } catch { res.status(503).json({ error: 'Channel quote unavailable' }); }
  });
  app.get('/channels/reads/:id', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const id = req.params.id;
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) { res.sendStatus(404); return; }
    if (busy.has(id)) { res.status(409).json({ error: 'Settlement in progress' }); return; }
    busy.add(id);
    try {
      const q = get(id);
      if (!q) { res.sendStatus(404); return; }
      if (!q.payment) {
        if (Date.now() - q.created > CHANNEL_QUOTE_TTL_MS) { res.status(410).json({ error: 'Unpaid quote expired' }); return; }
        const header = req.get('PAYMENT-SIGNATURE');
        if (!header) {
          const required = await resource.createPaymentRequiredResponse([q.requirements], { url: `${req.protocol}://${req.get('host')}${req.originalUrl}`, description: 'Bounded forecast bundle; pay only delivered reads', mimeType: 'application/json' });
          res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(required)).toString('base64'));
          res.status(402).json(required); return;
        }
        if (header.length > 32768) { res.sendStatus(400); return; }
        const p = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as PaymentPayload;
        // Reject quote substitution, including timeout/authorizer changes, before any deposit.
        if (p.x402Version !== 2 || JSON.stringify(p.accepted) !== JSON.stringify(q.requirements) || typeof p.payload?.channelId !== 'string') { res.status(400).json({ error: 'Payment does not match quote' }); return; }
        o.db.transaction(() => {
          o.db.prepare('INSERT INTO channel_payments VALUES(?,?)').run(p.payload.channelId, id);
          q.payment = p; save(q);
        }).immediate();
        if (p.x402Version !== 2 || !isDeepStrictEqual(p.accepted, q.requirements) || typeof p.payload?.channelId !== 'string') { res.status(400).json({ error: 'Payment does not match quote' }); return; }
      }
      if (!q.deposited) {
        const result = await resource.settlePayment(q.payment!, q.requirements, {}, undefined, undefined, 'before-handler');
        if (!result.success) { res.status(503).json({ error: 'Deposit pending', reason: result.errorReason }); return; }
        q.deposited = true; save(q);
      }
      if (!q.body) {
        const forecasts: PaidForecast[] = [];
        let amount = 0;
        for (const item of q.items) {
          const value = await o.deliver(item.forecastPda).catch(() => undefined);
          if (value) { forecasts.push(value); amount += item.amount; }
        }
        // Persist the exact recoverable delivery before authorizing the actual charge.
        q.body = { id, forecasts, amount: String(amount) }; save(q);
      }
      if (!q.settlement) {
        const result = await resource.settlePayment(q.payment!, q.requirements, {}, undefined, { amount: q.body.amount }, 'after-handler');
        if (!result.success) { res.status(503).json({ error: 'Claim pending', reason: result.errorReason }); return; }
        q.settlement = Buffer.from(JSON.stringify(result)).toString('base64'); save(q);
      }
      res.setHeader('PAYMENT-RESPONSE', q.settlement);
      res.json(q.body);
    } catch (e) { log('error', 'Channel read pending', { id, reason: e instanceof Error ? e.message.slice(0, 160) : 'unknown' }); res.status(503).json({ error: 'Channel pending; recover using the same quote ID' }); }
    finally { busy.delete(id); }
  });
}
