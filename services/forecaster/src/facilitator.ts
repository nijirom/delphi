import express from 'express';
import { resolve } from 'node:path';
import { chmodSync } from 'node:fs';
import Database from 'better-sqlite3';
import { loadEnv, REPO_ROOT, loadKeypair, log } from '@delphi/shared';
import { registerChannelFacilitator } from './channel-facilitator.js';

// Private x402 facilitator supporting `exact` and `upto` (payment channels). Its key sponsors SOL fees: bind it to loopback.
const env = loadEnv();
const keypair = process.env.FACILITATOR_KEYPAIR;
if (!keypair) throw new Error('FACILITATOR_KEYPAIR is required');
process.umask(0o077);
const path = resolve(REPO_ROOT, process.env.FACILITATOR_DB || 'data/facilitator.sqlite');
const db = new Database(path);
db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
chmodSync(path, 0o600);
const app = express();
app.disable('x-powered-by');
await registerChannelFacilitator(app, { db, wallet: loadKeypair(keypair), rpcUrl: env.SOLANA_RPC_URL, network: env.SOLANA_NETWORK_CAIP2 as `${string}:${string}`, treasuryOwner: process.env.PAYMENT_CHANNELS_TREASURY_OWNER || undefined });
const port = Number(process.env.FACILITATOR_PORT || 4050);
app.listen(port, '127.0.0.1', () => log('info', 'Facilitator listening', { port }));
