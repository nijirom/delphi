import express from 'express';
import type { Response } from 'express';
import { resolve } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { loadEnv, REPO_ROOT, log } from '@delphi/shared';
import { authorized, normalizePayload, telemetry } from './input.js';
import { Store } from './store.js';
import { ChainIndexer } from './chain.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const secret = String(env.STREAMS_WEBHOOK_SECRET ?? '');
  if (!authorized(secret, secret)) throw new Error('Configure a nonempty STREAMS_WEBHOOK_SECRET other than change-me');
  const source = process.env.INDEXER_SOURCE ?? 'streams';
  if (source !== 'streams' && source !== 'rpc') throw new Error('Invalid INDEXER_SOURCE');
  const store = new Store(resolve(REPO_ROOT, env.INDEXER_DB));
  const clients = new Set<Response>();
  function broadcast(kind: string, value: unknown): void {
    const message = `event: ${kind}\ndata: ${JSON.stringify(value)}\n\n`;
    for (const res of clients) if (!res.write(message)) { clients.delete(res); res.end(); }
  }
  const chain = new ChainIndexer(store, new PublicKey(env.DELPHI_PROGRAM_ID), env.SOLANA_RPC_URL, resolve(REPO_ROOT, 'packages/shared/idl/delphi.json'), env.USDC_MINT, event => broadcast('event', event));
  let lastErrorAt: number | null = null;
  let stopping = false;
  let busy = false;
  async function cycle(): Promise<void> {
    if (busy || stopping) return;
    busy = true;
    try {
      await chain.refresh();
      if (source === 'rpc') await chain.poll();
      lastErrorAt = null;
    } catch { lastErrorAt = Date.now(); log('error', 'Indexer chain refresh or polling failed'); }
    finally { busy = false; }
  }
  await cycle();
  const app = express();
  app.disable('x-powered-by');
  // Authenticate before allocating JSON bodies, including malformed/oversized requests.
  app.use(['/webhooks/streams', '/telemetry'], (req, res, next) => {
    if (req.method === 'POST' && !authorized(secret, req.headers['x-streams-secret'])) { res.status(401).json({ error: 'Unauthorized' }); return; }
    next();
  });
  app.use(express.json({ limit: '8mb', strict: true }));
  app.post('/webhooks/streams', (req, res) => {
    let rows;
    try { rows = normalizePayload(req.body as unknown); }
    catch { res.status(400).json({ error: 'Invalid Streams payload' }); return; }
    if (!chain.ready) { res.status(503).json({ error: 'Chain snapshot unavailable; retry delivery' }); return; }
    try {
      for (const row of rows) chain.ingest(row);
      res.json({ accepted: rows.length });
    } catch { log('error', 'Streams ingestion failed; delivery can be retried'); res.status(503).json({ error: 'Ingestion failed; retry delivery' }); }
  });
  app.post('/telemetry', (req, res) => {
    let value;
    try { value = telemetry(req.body as unknown); }
    catch { res.status(400).json({ error: 'Invalid or sensitive telemetry' }); return; }
    store.addTelemetry(value); broadcast('telemetry', value); res.status(202).json({ accepted: true });
  });
  function integer(value: unknown, fallback: number, max: number): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new Error('Invalid query');
    return Number(value);
  }
  app.get('/events', (req, res) => {
    try {
      const kind = req.query.kind;
      if (kind !== undefined && (typeof kind !== 'string' || !['forecast_posted', 'purchase_recorded', 'market_resolved', 'forecast_scored', 'usdc_transfer'].includes(kind))) throw new Error('Invalid kind');
      res.json(store.events(integer(req.query.limit, 100, 1000), integer(req.query.since, 0, Number.MAX_SAFE_INTEGER), kind));
    } catch { res.status(400).json({ error: 'Invalid query; since is an exclusive event ID' }); }
  });
  app.get('/leaderboard', (_req, res) => res.json(store.leaderboard()));
  app.get('/telemetry', (req, res) => {
    try { res.json(store.telemetry(integer(req.query.limit, 100, 1000))); }
    catch { res.status(400).json({ error: 'Invalid query' }); }
  });
  app.get('/health', (_req, res) => {
    const snapshotAt = Number(store.get('snapshotAt') ?? 0);
    const healthy = chain.ready && Date.now() - snapshotAt < 180000 && lastErrorAt === null;
    res.status(healthy ? 200 : 503).json({ ok: healthy, source, snapshotAt: snapshotAt || null, rpcPollAt: Number(store.get('rpcPollAt') ?? 0) || null, lastErrorAt });
  });
  app.get('/stream', (req, res) => {
    if (clients.size >= 200) { res.status(503).end(); return; }
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders(); res.write(': connected\n\n'); clients.add(res);
    const heartbeat = setInterval(() => { if (!res.write(': heartbeat\n\n')) res.end(); }, 15000);
    req.on('close', () => { clearInterval(heartbeat); clients.delete(res); });
  });
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (!res.headersSent) res.status(400).json({ error: 'Request failed' });
  });
  const port = Number(env.INDEXER_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid INDEXER_PORT');
  const server = app.listen(port, process.env.INDEXER_HOST ?? '127.0.0.1', () => log('info', 'Indexer listening', { port, source }));
  server.requestTimeout = 30000; server.headersTimeout = 15000;
  server.on('error', () => { log('error', 'Indexer HTTP server failed'); process.exitCode = 1; void shutdown(); });
  const timer = setInterval(() => { void cycle(); }, source === 'rpc' ? 10000 : 60000);
  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true; clearInterval(timer);
    for (const res of clients) res.end(); clients.clear();
    server.close();
    while (busy) await new Promise(r => setTimeout(r, 50));
    store.db.close();
  }
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}
main().catch(() => { log('error', 'Indexer startup failed; check configuration, IDL and RPC availability'); process.exitCode = 1; });
