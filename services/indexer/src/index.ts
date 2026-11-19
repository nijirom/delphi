import express from 'express';
import type { Response } from 'express';
import { resolve } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { loadEnv, REPO_ROOT, log, GeminiClient, surviveTransientRpcRejections } from '@delphi/shared';
import { authorized, normalizePayload, quicknodeSignatureValid, streamsDeliveryState, telemetry } from './input.js';
import { Store } from './store.js';
import { ChainIndexer } from './chain.js';
import { Markets } from './markets.js';

async function main(): Promise<void> {
  const env = loadEnv();
  surviveTransientRpcRejections();
  // Public RPCs cap getProgramAccounts per IP; a shared endpoint needs a slower snapshot cadence.
  const pollMs = Number(process.env.INDEXER_POLL_MS || 0);
  if (pollMs && (!Number.isInteger(pollMs) || pollMs < 5000)) throw new Error('INDEXER_POLL_MS must be an integer >= 5000');
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
  const markets = new Markets(store, chain, new GeminiClient({ publicBase: env.GEMINI_PUBLIC_API_BASE, privateBase: env.GEMINI_API_BASE }));
  const clusters: Record<string, string> = {
    EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: 'devnet',
    '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY': 'testnet',
    '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'mainnet-beta',
  };
  let network: { cluster: string; programId: string } | null = null;
  let lastErrorAt: number | null = null;
  let stopping = false;
  let busy = false;
  async function cycle(): Promise<void> {
    if (busy || stopping) return;
    busy = true;
    try {
      if (!network) {
        const genesis = await chain.rpc.getGenesisHash();
        const host = new URL(env.SOLANA_RPC_URL).hostname;
        const cluster = clusters[genesis] ?? (['localhost', '127.0.0.1', '[::1]'].includes(host) ? 'localnet' : 'custom');
        network = { cluster, programId: chain.programId.toBase58() };
      }
      await chain.refresh();
      if (source === 'rpc') await chain.poll();
      try { await markets.refresh(); } catch { log('warn', 'Gemini market metadata refresh failed'); }
      lastErrorAt = null;
    } catch (e) { lastErrorAt = Date.now(); log('error', 'Indexer chain refresh or polling failed', { reason: e instanceof Error ? e.message.slice(0, 120) : 'unknown' }); }
    finally { busy = false; }
  }
  // Serve immediately: /health reports the snapshot as not yet ready while a slow RPC catches up.
  void cycle();
  const app = express();
  app.disable('x-powered-by');
  // Optional: the Stream's security token. Either it (QuickNode's signed headers) or the shared header authenticates a delivery.
  const streamsToken = process.env.STREAMS_SECURITY_TOKEN ?? '';
  // Telemetry: authenticate before allocating JSON bodies, including malformed/oversized requests.
  app.use('/telemetry', (req, res, next) => {
    if (req.method === 'POST' && !authorized(secret, req.headers['x-streams-secret'])) { res.status(401).json({ error: 'Unauthorized' }); return; }
    next();
  });
  // Delivery accounting so an operator can tell whether QuickNode is actually sending.
  const streams = { deliveries: 0, rows: 0, rejected: 0, unauthorized: 0, lastAt: null as number | null };
  // Refuse before reading the body unless some credential is present; the HMAC itself needs the decoded body.
  app.use('/webhooks/streams', (req, res, next) => {
    if (req.method !== 'POST' || authorized(secret, req.headers['x-streams-secret']) || (streamsToken && req.headers['x-qn-signature'])) { next(); return; }
    streams.unauthorized++;
    log('warn', 'Streams delivery unauthorized: no x-streams-secret header and no QuickNode signature (set STREAMS_SECURITY_TOKEN)');
    res.status(401).json({ error: 'Unauthorized' });
  });
  app.post('/webhooks/streams', express.raw({ type: () => true, limit: '8mb' }), (req, res) => {
    const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!authorized(secret, req.headers['x-streams-secret']) && !quicknodeSignatureValid(streamsToken, text, req.headers['x-qn-nonce'], req.headers['x-qn-timestamp'], req.headers['x-qn-signature'])) {
      streams.unauthorized++; log('warn', 'Streams delivery unauthorized: QuickNode signature invalid or outside the 5 minute window');
      res.status(401).json({ error: 'Unauthorized' }); return;
    }
    let rows;
    try { rows = normalizePayload(JSON.parse(text) as unknown); }
    catch { streams.rejected++; log('warn', 'Streams delivery rejected: invalid payload'); res.status(400).json({ error: 'Invalid Streams payload' }); return; }
    if (!chain.ready) { streams.rejected++; log('warn', 'Streams delivery deferred: snapshot not ready'); res.status(503).json({ error: 'Chain snapshot unavailable; retry delivery' }); return; }
    try {
      for (const row of rows) chain.ingest(row);
      streams.deliveries++; streams.rows += rows.length; streams.lastAt = Date.now();
      log('info', 'Streams delivery accepted', { rows: rows.length });
      res.json({ accepted: rows.length });
    } catch { streams.rejected++; log('error', 'Streams ingestion failed; delivery can be retried'); res.status(503).json({ error: 'Ingestion failed; retry delivery' }); }
  });
  app.post('/telemetry', express.json({ limit: '64kb', strict: true }), (req, res) => {
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
  function symbolQuery(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !/^[\w.\-]{1,64}$/.test(value)) throw new Error('Invalid symbol');
    return value;
  }
  app.get('/events', (req, res) => {
    try {
      const kind = req.query.kind;
      if (kind !== undefined && (typeof kind !== 'string' || !['forecast_posted', 'purchase_recorded', 'market_resolved', 'forecast_scored', 'usdc_transfer'].includes(kind))) throw new Error('Invalid kind');
      res.json(store.events(integer(req.query.limit, 100, 1000), integer(req.query.since, 0, Number.MAX_SAFE_INTEGER), kind, symbolQuery(req.query.symbol)));
    } catch { res.status(400).json({ error: 'Invalid query; since is an exclusive event ID' }); }
  });
  app.get('/leaderboard', (_req, res) => res.json(store.leaderboard()));
  app.get('/markets', (_req, res) => res.json(markets.list()));
  app.get('/markets/:symbol', (req, res) => {
    const symbol = String(req.params.symbol);
    if (!/^[\w.\-]{1,64}$/.test(symbol)) { res.status(400).json({ error: 'Invalid symbol' }); return; }
    const detail = markets.detail(symbol);
    if (!detail) { res.status(404).json({ error: 'Unknown market' }); return; }
    res.json(detail);
  });
  app.get('/categories', (_req, res) => res.json(markets.categories()));
  app.get('/telemetry', (req, res) => {
    try { res.json(store.telemetry(integer(req.query.limit, 100, 1000), symbolQuery(req.query.symbol))); }
    catch { res.status(400).json({ error: 'Invalid query' }); }
  });
  app.get('/health', (_req, res) => {
    const now = Date.now(), snapshotAt = Number(store.get('snapshotAt') ?? 0) || null;
    const rpcPollAt = Number(store.get('rpcPollAt') ?? 0) || null;
    const rpc = chain.rpcHealth();
    const deliveryState = streamsDeliveryState(streams.deliveries, streams.lastAt, now);
    type Readiness = 'ready' | 'degraded' | 'incomplete';
    const snapshotStatus: Readiness = !chain.ready || snapshotAt === null ? 'incomplete' : now - snapshotAt >= 180000 || lastErrorAt !== null ? 'degraded' : 'ready';
    const sourceStatus: Readiness = source === 'rpc'
      ? rpcPollAt === null || rpc.droppedSignatures > 0 ? 'incomplete' : rpc.recipientHistoryFailuresThisPoll > 0 ? 'degraded' : 'ready'
      : deliveryState === 'no_deliveries' ? 'incomplete' : deliveryState === 'stale' ? 'degraded' : 'ready';
    const status: Readiness = snapshotStatus === 'incomplete' || sourceStatus === 'incomplete' ? 'incomplete'
      : snapshotStatus === 'degraded' || sourceStatus === 'degraded' ? 'degraded' : 'ready';
    res.status(status === 'ready' ? 200 : 503).json({
      ok: status === 'ready', source, network, snapshotAt, rpcPollAt, lastErrorAt,
      readiness: { status, snapshot: snapshotStatus, source: sourceStatus },
      rpc,
      streams: { ...streams, deliveryState, staleAfterMs: 180000 },
    });
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
  const timer = setInterval(() => { void cycle(); }, pollMs || (source === 'rpc' ? 10000 : 30000));
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
// Startup failures are configuration errors this process raised itself; their messages are safe and actionable. `log` still scrubs URLs and env secrets.
main().catch((e: unknown) => { log('error', 'Indexer startup failed', { reason: e instanceof Error ? e.message : String(e) }); process.exitCode = 1; });
