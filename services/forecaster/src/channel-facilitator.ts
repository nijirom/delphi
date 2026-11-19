import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import express, { type Express } from 'express';
import type Database from 'better-sqlite3';
import { Transaction, VersionedTransaction, type Keypair } from '@solana/web3.js';
import { createKeyPairSignerFromBytes, getBase58Decoder } from '@solana/kit';
import { x402Facilitator } from '@x402/core/facilitator';
import type { PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { toFacilitatorSvmSigner } from '@x402/svm';
import { UptoSvmScheme, UptoSvmRentCleanupManager } from '@x402/svm/upto/facilitator';
import { ExactSvmScheme } from '@x402/svm/exact/facilitator';
import { log } from '@delphi/shared';
import { sqliteChannelStorage } from './channel-storage.js';

type Operation = { key: string; payload: PaymentPayload; requirements: PaymentRequirements; transaction?: string; result?: SettleResponse };
/** Local/private facilitator. Its fee-payer wallet sponsors SOL; do not expose without admission controls.
 * The SDK's upto pending store alone has a broadcast/crash gap. Persist signed wire bytes BEFORE
 * sendTransaction, then recover those bytes rather than constructing another settlement.
 */
export async function registerChannelFacilitator(app: Express, o: { db: Database.Database; wallet: Keypair; rpcUrl: string; network: `${string}:${string}`; treasuryOwner?: string }): Promise<void> {
  o.db.exec('CREATE TABLE IF NOT EXISTS facilitator_operations (key TEXT PRIMARY KEY, payload TEXT NOT NULL)');
  const get = (key: string): Operation | undefined => {
    const row = o.db.prepare('SELECT payload FROM facilitator_operations WHERE key=?').get(key) as { payload: string } | undefined;
    return row && JSON.parse(row.payload) as Operation;
  };
  const save = (op: Operation) => { o.db.prepare('INSERT INTO facilitator_operations VALUES(?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload').run(op.key, JSON.stringify(op)); };
  const context = new AsyncLocalStorage<Operation>();
  const signer = toFacilitatorSvmSigner(await createKeyPairSignerFromBytes(o.wallet.secretKey), { defaultRpcUrl: o.rpcUrl });
  const send = signer.sendTransaction.bind(signer);
  signer.sendTransaction = async (transaction, network) => {
    const op = context.getStore();
    if (!op) throw new Error('Settlement lacks durable operation');
    if (op.transaction && op.transaction !== transaction) throw new Error('Replacement settlement transaction blocked');
    op.transaction = transaction; save(op);
    return send(transaction, network);
  };
  const channelStorage = sqliteChannelStorage(o.db);
  // Channels opened before records were durable: rebuild their rows from the persisted deposit operations so cleanup can close them.
  for (const row of o.db.prepare("SELECT payload FROM facilitator_operations WHERE key LIKE ?").all(`${o.network}:deposit:%`) as { payload: string }[]) {
    const op = JSON.parse(row.payload) as Operation;
    const p = op.payload.payload as { channelId?: unknown; expiresAt?: unknown };
    const tokenProgram = (op.requirements.extra as { tokenProgram?: unknown } | undefined)?.tokenProgram;
    if (op.result?.success !== true || typeof p.channelId !== 'string' || typeof p.expiresAt !== 'number' || typeof tokenProgram !== 'string') continue;
    if (await channelStorage.get(o.network, p.channelId)) continue;
    await channelStorage.recordActivity({ network: o.network, channelId: p.channelId, payTo: op.requirements.payTo, tokenProgram, expiresAt: p.expiresAt, lastActivityAt: Date.now(), receiverAuthorizer: '', callerIdentity: '' });
  }
  const facilitator = new x402Facilitator()
    .register(o.network, new UptoSvmScheme(signer, { transactionVersions: [0], facilitatorTransactionVersion: 0, paymentChannelsTreasuryOwner: o.treasuryOwner, channelStorage }))
    .register(o.network, new ExactSvmScheme(signer, undefined, { transactionVersions: [0] }));
  // Expired channels are abandon-closed at their on-chain settled amount: the recipient keeps what was claimed and the
  // payer's unclaimed escrow is returned; rent comes back to the facilitator. Cleanup has its own signer because the
  // settlement signer refuses any transaction not bound to a durable payment operation.
  const cleanupSigner = toFacilitatorSvmSigner(await createKeyPairSignerFromBytes(o.wallet.secretKey), { defaultRpcUrl: o.rpcUrl });
  const cleanup = new UptoSvmRentCleanupManager({ signer: cleanupSigner, storage: channelStorage, network: o.network, treasuryOwner: o.treasuryOwner, facilitatorTransactionVersion: 0 });
  cleanup.start({
    intervalSecs: 120,
    onClose: result => log('info', 'Channel escrow cleanup confirmed', { ...result }),
    onReclaim: result => log('info', 'Channel rent reclaimed', { ...result }),
    onError: (error, context) => log('warn', 'Channel cleanup pending', {
      channelId: context?.channelId,
      reason: error instanceof Error ? error.message : 'Unknown cleanup failure',
    }),
  });
  log('info', 'Channel cleanup started', { channels: (await channelStorage.list(o.network)).length });
  app.use(express.json({ limit: '64kb' }));
  app.get('/supported', (_req, res) => res.json(facilitator.getSupported()));
  app.post('/verify', async (req, res) => {
    try { res.json(await facilitator.verify(req.body.paymentPayload, req.body.paymentRequirements)); }
    catch { res.status(400).json({ isValid: false, invalidReason: 'Invalid payment' }); }
  });
  const busy = new Set<string>();
  app.post('/settle', async (req, res) => {
    const payload = req.body?.paymentPayload as PaymentPayload, requirements = req.body?.paymentRequirements as PaymentRequirements;
    if (!payload?.payload || requirements?.network !== o.network) { res.sendStatus(400); return; }
    const channel = payload.payload.channelId ?? payload.payload.transaction;
    const phase = payload.payload.type ?? 'exact';
    if (typeof channel !== 'string' || typeof phase !== 'string') { res.sendStatus(400); return; }
    const key = `${o.network}:${phase}:${channel}`;
    if (busy.has(key)) { res.status(503).json({ error: 'Settlement in progress' }); return; }
    busy.add(key);
    try {
      let op = get(key);
      if (op && (!isDeepStrictEqual(op.payload, payload) || !isDeepStrictEqual(op.requirements, requirements))) { res.status(409).json({ error: 'Operation already bound' }); return; }
      if (!op) { op = { key, payload, requirements }; save(op); }
      if (!op.result && op.transaction) {
        // Re-broadcasting IDENTICAL signed bytes cannot pay twice. Expired bytes are never replaced.
        // sendTransaction may reject an already-confirmed transaction; derive its signature first.
        const wire = Buffer.from(op.transaction, 'base64');
        let signature: Uint8Array;
        try { signature = VersionedTransaction.deserialize(wire).signatures[0]!; }
        catch { signature = Transaction.from(wire).signature!; }
        const transaction = getBase58Decoder().decode(signature);
        await send(op.transaction, o.network).catch(() => undefined);
        await signer.confirmTransaction(transaction, o.network, { searchTransactionHistory: true });
        op.result = { success: true, transaction, network: o.network, amount: requirements.amount, payer: String(payload.payload.from ?? '') }; save(op);
      }
      if (!op.result) {
        const current = op;
        const result = await context.run(current, () => facilitator.settle(payload, requirements));
        if (result.success) { current.result = result; save(current); }
        else log('warn', 'Facilitator settlement declined', { key, reason: result.errorReason ?? 'unknown' });
        res.json(result); return;
      }
      res.json(op.result);
    } catch (e) { log('error', 'Facilitator settlement failed; identical payment may be retried', { key, reason: e instanceof Error ? e.message.slice(0, 160) : 'unknown' }); res.status(503).json({ error: 'Settlement pending; retry identical payment' }); }
    finally { busy.delete(key); }
  });
}
