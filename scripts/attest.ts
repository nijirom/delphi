import { parseArgs } from 'node:util';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PublicKey } from '@solana/web3.js';
import { loadEnv, REPO_ROOT, connection, loadKeypair, DelphiProgram, GeminiClient, eventTickerFromSymbol, signSettlement, log, type MarketAccount, type SettlementAttestation } from '@delphi/shared';

/**
 * One settlement signer. Each signer runs this with its own key, reads Gemini
 * itself, and signs only an outcome it observed. The resolver merely relays
 * signatures; it cannot manufacture a quorum.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    keypair: { type: 'string' }, out: { type: 'string' }, post: { type: 'string' }, watch: { type: 'boolean', default: false }, interval: { type: 'string', default: '30' }, help: { type: 'boolean' },
  }, strict: true });
  if (values.help || !values.keypair) {
    console.log('Usage: npm run attest -- --keypair keys/settlement-signer-1.json [--post https://resolver.example | --out data/attestations] [--watch [--interval 30]]\nSigns `delphi:settlement:v1` attestations for every unresolved Delphi market that Gemini reports as settled Yes/No, then submits them to the resolver (--post) or writes them to a local directory. The key must be listed in the on-chain settlement config. --interval is seconds between passes (>= 10).');
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  const env = loadEnv();
  const intervalMs = Number(values.interval) * 1000;
  if (!Number.isInteger(intervalMs) || intervalMs < 10000) throw new Error('--interval must be an integer >= 10 seconds');
  const signer = loadKeypair(values.keypair);
  const client = new DelphiProgram(connection(env), signer, new PublicKey(env.DELPHI_PROGRAM_ID));
  const gemini = new GeminiClient({ publicBase: env.GEMINI_PUBLIC_API_BASE, privateBase: env.GEMINI_API_BASE });
  const post = values.post ? new URL('/attestations', values.post) : undefined;
  if (post && post.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(post.hostname)) throw new Error('--post requires HTTPS or loopback');
  const out = resolve(REPO_ROOT, values.out ?? process.env.SETTLEMENT_ATTESTATIONS_DIR ?? 'data/attestations');
  if (!post) mkdirSync(out, { recursive: true, mode: 0o700 });
  let policy = null;
  for (let attempt = 1; ; attempt++) {
    try { policy = await client.fetchSettlementConfig(); break; }
    catch (e) { if (attempt >= 5) throw e; await sleep(2000 * attempt); }
  }
  if (!policy) throw new Error('Settlement quorum is not initialized on-chain');
  if (!policy.signers.some(key => key.equals(signer.publicKey))) throw new Error('This keypair is not an authorized settlement signer');

  async function deliver(attestation: SettlementAttestation): Promise<boolean> {
    if (post) {
      // The resolver verifies the signature itself; a rejection means this signer's key or view is wrong.
      const response = await fetch(post, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(attestation), redirect: 'error', signal: AbortSignal.timeout(15000) });
      await response.body?.cancel();
      if (!response.ok) log('error', 'Resolver rejected attestation', { market: attestation.market, status: response.status });
      return response.ok;
    }
    const file = join(out, `${attestation.market}-${attestation.signer}.json`);
    // Atomic replace: the resolver never reads a half-written file.
    writeFileSync(`${file}.tmp`, JSON.stringify(attestation), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    return true;
  }

  do {
    let signed = 0;
    let markets: { pubkey: PublicKey; account: MarketAccount }[];
    // A rate-limited or unreachable RPC skips this pass; a watching signer must not exit on a transient error.
    try { markets = (await client.allMarkets()).filter(m => !m.account.resolved); }
    catch (e) {
      if (!values.watch) throw e;
      log('warn', 'Market enumeration failed; retrying next pass', { reason: e instanceof Error ? e.message.slice(0, 80) : 'unknown' });
      await sleep(intervalMs);
      continue;
    }
    const byEvent = new Map<string, string[]>();
    for (const { account } of markets) {
      const ticker = eventTickerFromSymbol(account.instrumentSymbol);
      byEvent.set(ticker, [...byEvent.get(ticker) ?? [], account.instrumentSymbol]);
    }
    for (const [ticker, symbols] of byEvent) {
      let event;
      try { event = await gemini.getEvent(ticker); } catch { continue; }
      for (const symbol of symbols) {
        const contract = event.contracts.find(c => c.instrumentSymbol === symbol);
        // Same rule as the resolver: an exact contract, settled/resolved, with a Yes/No side.
        if (!contract || !['settled', 'resolved'].includes(contract.status.toLowerCase()) || (contract.resolutionSide !== 'yes' && contract.resolutionSide !== 'no')) continue;
        try { if (await deliver(signSettlement(client.settlementBinding(symbol, contract.resolutionSide === 'yes'), signer))) signed++; }
        catch { log('error', 'Attestation delivery failed; retrying next pass', { instrumentSymbol: symbol }); }
      }
    }
    log('info', 'Settlement attestations delivered', { signer: signer.publicKey.toBase58(), unresolved: markets.length, signed, transport: post ? 'http' : 'directory' });
    if (values.watch) await sleep(intervalMs);
  } while (values.watch);
}
main().catch((e: unknown) => { log('error', 'Attestation failed', { reason: e instanceof Error ? e.message : 'unknown' }); process.exitCode = 1; });
