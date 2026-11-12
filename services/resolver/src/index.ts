import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { loadEnv, REPO_ROOT, log, connection, loadKeypair, DelphiProgram, GeminiClient, commitment } from '@delphi/shared';
import { openStore, rows } from '@delphi/forecaster/store';

const env = loadEnv();
const client = new DelphiProgram(connection(env), loadKeypair(env.DELPHI_ORACLE_KEYPAIR), new PublicKey(env.DELPHI_PROGRAM_ID));
const gemini = new GeminiClient({ publicBase: env.GEMINI_PUBLIC_API_BASE, privateBase: env.GEMINI_API_BASE });
const path = resolve(REPO_ROOT, process.env.FORECASTER_DB || 'data/forecaster.sqlite');
let stopping = false;
let running: Promise<void> | undefined;
let lastSuccess = 0;
let lastAttempt = 0;
async function poll(): Promise<void> {
  lastAttempt = Date.now();
  if (!existsSync(path)) { log('warn', 'Reveal database missing; resolver will retry'); return; }
  const db = openStore(path, true);
  let reveals: ReturnType<typeof rows>;
  try { reveals = rows(db); } finally { db.close(); }
  let failures = 0;
  for (const ticker of new Set(reveals.map(r => r.event_ticker))) {
    if (stopping) return;
    try {
      const event = await gemini.getEvent(ticker);
      for (const row of reveals.filter(r => r.event_ticker === ticker)) {
        if (stopping) return;
        try {
          const contract = event.contracts.find(c => c.instrumentSymbol === row.instrument_symbol);
          if (!contract || !['settled', 'resolved'].includes(contract.status.toLowerCase()) || (contract.resolutionSide !== 'yes' && contract.resolutionSide !== 'no')) continue;
          let market = await client.fetchMarket(row.instrument_symbol);
          if (!market) continue;
          const outcome = contract.resolutionSide === 'yes';
          if (!market.resolved) {
            try { await client.resolveMarket(row.instrument_symbol, outcome); }
            catch { const current = await client.fetchMarket(row.instrument_symbol); if (!current?.resolved || current.outcomeYes !== outcome) throw new Error('Resolve failed'); }
            market = await client.fetchMarket(row.instrument_symbol);
          }
          if (!market?.resolved || market.outcomeYes !== outcome) throw new Error('Settlement disagreement');
          const address = new PublicKey(row.forecast_pda);
          const chain = await client.fetchForecast(address);
          if (!chain || chain.revealed) continue;
          const salt = Buffer.from(row.salt_hex, 'hex');
          if (salt.length !== 32 || !Buffer.from(chain.commitment).equals(Buffer.from(commitment(row.prob_bps, salt)))) throw new Error('Local reveal does not match commitment');
          try { await client.revealAndScore(address, row.prob_bps, salt); }
          catch { if (!(await client.fetchForecast(address))?.revealed) throw new Error('Reveal failed'); }
          log('info', 'Forecast scored', { forecastPda: row.forecast_pda });
        } catch { failures++; log('error', 'Settlement or reveal failed; retrying next poll', { forecastPda: row.forecast_pda }); }
      }
    } catch { failures++; log('error', 'Event settlement lookup failed'); }
  }
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
