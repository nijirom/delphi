import express from 'express';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { loadEnv, REPO_ROOT, log, connection, loadKeypair, DelphiProgram, GeminiClient, commitment, chainTime, pdas, verifySettlementAttestation, surviveTransientRpcRejections, type ForecastAccount } from '@delphi/shared';
import { openStore, rows, type Reveal } from '@delphi/forecaster/store';
import { resolveSettled, forfeitSweep, settleBondSweep, type MarketRow } from './settlement.js';
import { resolveAttestedMarket } from './attestations.js';

const env = loadEnv();
surviveTransientRpcRejections();
const conn = connection(env);
const client = new DelphiProgram(conn, loadKeypair(env.DELPHI_ORACLE_KEYPAIR), new PublicKey(env.DELPHI_PROGRAM_ID));
const gemini = new GeminiClient({ publicBase: env.GEMINI_PUBLIC_API_BASE, privateBase: env.GEMINI_API_BASE });
const attestationsDirectory = resolve(REPO_ROOT, process.env.SETTLEMENT_ATTESTATIONS_DIR || 'data/attestations');
const settlementClient = {
  fetchMarket: (symbol: string) => client.fetchMarket(symbol),
  resolveMarket: (symbol: string, outcome: boolean) => resolveAttestedMarket(client, symbol, outcome, attestationsDirectory),
};
const path = resolve(REPO_ROOT, process.env.FORECASTER_DB || 'data/forecaster.sqlite');
let stopping = false;
let running: Promise<void> | undefined;
let lastSuccess = 0;
let lastAttempt = 0;
/** Forecast PDAs the chain has confirmed revealed or forfeited. Those states are terminal, so the rows are never fetched again. */
const scored = new Set<string>();
async function scoreOwned(protect: Set<string>): Promise<number> {
  const db = openStore(path, true);
  let reveals: Reveal[];
  try { reveals = rows(db); } finally { db.close(); }
  let failures = 0;
  // Every local reveal is protected before anything is fetched. Protection is withdrawn only when the chain proves the salt does not open the commitment; an RPC or Gemini failure must not forfeit a forecast this process can still reveal.
  const pending = reveals.filter(row => !scored.has(row.forecast_pda));
  for (const row of pending) protect.add(row.forecast_pda);
  if (!pending.length || stopping) return failures;
  let unscoredMap: Map<string, ForecastAccount> | null = null;
  try {
    unscoredMap = new Map((await client.unscoredForecasts()).map(r => [r.pubkey.toBase58(), r.account]));
  } catch {
    unscoredMap = null;
  }
  const openable: Reveal[] = [];
  for (const row of pending) {
    if (stopping) return failures;
    try {
      const chain = unscoredMap?.get(row.forecast_pda) ?? await client.fetchForecast(new PublicKey(row.forecast_pda));
      if (!chain) continue;
      if (chain.revealed || chain.forfeited) { scored.add(row.forecast_pda); continue; }
      const salt = Buffer.from(row.salt_hex, 'hex');
      if (salt.length !== 32 || !Buffer.from(chain.commitment).equals(Buffer.from(commitment(row.prob_bps, salt)))) {
        protect.delete(row.forecast_pda); failures++;
        log('error', 'Local reveal does not open the on-chain commitment; the sweep will forfeit it', { forecastPda: row.forecast_pda });
        continue;
      }
      openable.push(row);
    } catch { failures++; log('error', 'Local reveal could not be verified; retrying next poll', { forecastPda: row.forecast_pda }); }
  }
  for (const ticker of new Set(openable.map(r => r.event_ticker))) {
    if (stopping) return failures;
    try {
      const event = await gemini.getEvent(ticker);
      for (const row of openable.filter(r => r.event_ticker === ticker)) {
        if (stopping) return failures;
        try {
          const contract = event.contracts.find(c => c.instrumentSymbol === row.instrument_symbol);
          if (!contract || !['settled', 'resolved'].includes(contract.status.toLowerCase()) || (contract.resolutionSide !== 'yes' && contract.resolutionSide !== 'no')) continue;
          let market = await client.fetchMarket(row.instrument_symbol);
          if (!market) continue;
          const outcome = contract.resolutionSide === 'yes';
          if (!market.resolved) {
            try { await settlementClient.resolveMarket(row.instrument_symbol, outcome); }
            catch { const current = await client.fetchMarket(row.instrument_symbol); if (!current?.resolved || current.outcomeYes !== outcome) throw new Error('Resolve failed'); }
            market = await client.fetchMarket(row.instrument_symbol);
          }
          if (!market?.resolved || market.outcomeYes !== outcome) throw new Error('Settlement disagreement');
          const address = new PublicKey(row.forecast_pda);
          const salt = Buffer.from(row.salt_hex, 'hex');
          try { await client.revealAndScore(address, row.prob_bps, salt); }
          catch {
            const current = await client.fetchForecast(address);
            if (current?.forfeited) { scored.add(row.forecast_pda); continue; }
            if (!current?.revealed) throw new Error('Reveal failed');
          }
          scored.add(row.forecast_pda);
          log('info', 'Forecast scored', { forecastPda: row.forecast_pda });
        } catch { failures++; log('error', 'Settlement or reveal failed; retrying next poll', { forecastPda: row.forecast_pda }); }
      }
    } catch { failures++; log('error', 'Event settlement lookup failed', { eventTicker: ticker }); }
  }
  return failures;
}
async function poll(): Promise<void> {
  lastAttempt = Date.now();
  if (stopping) return;
  let failures = 0;
  const protect = new Set<string>();
  const revealsReady = existsSync(path);
  if (!revealsReady) log('warn', 'Reveal database missing; resolver will still forfeit overdue forecasts');
  else failures += await scoreOwned(protect);
  if (stopping) return;
  let markets: MarketRow[];
  try { markets = await client.allMarkets(); } catch { log('error', 'Market enumeration failed; settlement and forfeit passes skipped'); return; }
  failures += await resolveSettled(markets, { client: settlementClient, gemini, isStopping: () => stopping });
  if (stopping) return;
  failures += await forfeitSweep(markets, protect, { client, chainTime: () => chainTime(conn), isStopping: () => stopping });
  failures += await settleBondSweep(client, () => stopping);
  if (!failures) lastSuccess = Date.now();
}
function tick(): void {
  if (stopping || running) return;
  running = poll().catch(() => log('error', 'Resolver poll failed')).finally(() => { running = undefined; });
}
const app = express();
app.disable('x-powered-by');
app.get('/health', (_req, res) => {
  const ok = lastSuccess > 0 && Date.now() - lastSuccess < 180000;
  res.status(ok ? 200 : 503).json({ ok, lastAttempt, lastSuccess, databaseAvailable: existsSync(path) });
});
// Signers on other machines submit here. Only a valid signature from a configured signer, bound to this program and
// settlement config, is stored; anything else is rejected, so the endpoint needs no other authentication.
app.post('/attestations', express.json({ limit: '4kb', strict: true }), async (req, res) => {
  try {
    const body: unknown = req.body;
    if (!body || typeof body !== 'object' || !('market' in body) || typeof body.market !== 'string' || !('outcomeYes' in body) || typeof body.outcomeYes !== 'boolean') { res.status(400).json({ error: 'Invalid attestation' }); return; }
    const policy = await client.fetchSettlementConfig();
    if (!policy) { res.status(503).json({ error: 'Settlement quorum is not initialized' }); return; }
    const market = new PublicKey(body.market);
    const attestation = verifySettlementAttestation(body, { programId: client.programId, config: pdas(client.programId).settlementConfig(), market, outcomeYes: body.outcomeYes }, policy);
    mkdirSync(attestationsDirectory, { recursive: true, mode: 0o700 });
    const file = resolve(attestationsDirectory, `${market.toBase58()}-${new PublicKey(attestation.signer).toBase58()}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(attestation), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    res.status(201).json({ accepted: true });
  } catch { res.status(400).json({ error: 'Attestation rejected' }); }
});
const port = Number(process.env.RESOLVER_PORT || 4040);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid RESOLVER_PORT');
const server = app.listen(port, process.env.RESOLVER_HOST || '127.0.0.1', () => log('info', 'Resolver listening', { port }));
server.requestTimeout = 15000;
const timer = setInterval(tick, 60000);
tick();
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  const deadline = setTimeout(() => process.exit(1), 30000); deadline.unref();
  await Promise.all([new Promise<void>(done => server.close(() => done())), running]);
  clearTimeout(deadline);
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
