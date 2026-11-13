import { mkdirSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, getMint } from '@solana/spl-token';
import { loadEnv, REPO_ROOT, connection, loadKeypair, DelphiProgram, pdas, log } from '@delphi/shared';
import { slugs } from '@delphi/forecaster/strategy';

async function main(): Promise<void> {
  const env = loadEnv();
  const conn = connection(env);
  const endpoint = new URL(env.SOLANA_RPC_URL);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  const genesis = await conn.getGenesisHash();
  const devnet = genesis === 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
  if (!devnet && !local) throw new Error('Setup only permits verified devnet or localhost RPC');
  if (genesis.startsWith('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp') || genesis.startsWith('4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z')) throw new Error('Mainnet and testnet are not permitted');
  const paths = [...new Set([env.DELPHI_ORACLE_KEYPAIR, env.BUYER_KEYPAIR, env.FORECASTER_KEYPAIR, ...slugs.map(s => `keys/persona-${s}.json`)])];
  for (const name of paths) {
    if (!name) throw new Error('Keypair paths must be configured');
    const path = resolve(REPO_ROOT, name);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!existsSync(path)) {
      const key = Keypair.generate();
      writeFileSync(path, JSON.stringify([...key.secretKey]), { mode: 0o600, flag: 'wx' });
    }
    chmodSync(path, 0o600);
    const key = loadKeypair(name);
    if (await conn.getBalance(key.publicKey, 'confirmed') < LAMPORTS_PER_SOL / 4) {
      const signature = await conn.requestAirdrop(key.publicKey, LAMPORTS_PER_SOL);
      const deadline = Date.now() + 60000;
      let confirmed = false;
      while (Date.now() < deadline) {
        const status = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
        if (status?.err) throw new Error('SOL airdrop failed');
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') { confirmed = true; break; }
        await new Promise(r => setTimeout(r, 1500));
      }
      if (!confirmed) throw new Error('SOL airdrop confirmation timed out; rerun setup');
    }
  }
  const oracle = loadKeypair(env.DELPHI_ORACLE_KEYPAIR);
  const mint = new PublicKey(env.USDC_MINT);
  const mintAccount = await getMint(conn, mint, 'confirmed');
  if (mintAccount.decimals !== 6) throw new Error('Configured USDC mint must have six decimals');
  for (const name of paths) {
    const key = loadKeypair(name);
    const ata = await getOrCreateAssociatedTokenAccount(conn, oracle, mint, key.publicKey, false, 'confirmed');
    log('info', 'Wallet and USDC ATA ready', { publicKey: key.publicKey.toBase58(), ata: ata.address.toBase58(), usdcBaseUnits: ata.amount.toString() });
  }
  log('info', 'No USDC faucet is invoked. Fund buyer USDC manually using the configured mint before enabling payments.');
  if (!env.DELPHI_PROGRAM_ID) { log('warn', 'Set DELPHI_PROGRAM_ID after deployment and rerun setup'); return; }
  const programId = new PublicKey(env.DELPHI_PROGRAM_ID);
  const deployed = await conn.getAccountInfo(programId, 'confirmed');
  if (!deployed?.executable) { log('warn', 'Program is not deployed; rerun setup after deployment'); return; }
  const client = new DelphiProgram(conn, oracle, programId);
  if (!await conn.getAccountInfo(pdas(programId).config(), 'confirmed')) await client.initialize();
  const price = BigInt(process.env.FORECASTER_PRICE_MICRO_USDC || '10000');
  if (price <= 0n || price > 1000000n) throw new Error('Invalid persona price');
  for (const slug of slugs) {
    const key = loadKeypair(`keys/persona-${slug}.json`);
    const persona = new DelphiProgram(conn, key, programId);
    const existing = await persona.fetchForecaster(key.publicKey);
    if (!existing) await persona.registerForecaster(slug, price);
    else if (existing.pricePerRead !== price) throw new Error('Registered persona price differs from configuration');
    log('info', 'Persona registered', { persona: slug, publicKey: key.publicKey.toBase58() });
  }
}
main().catch(() => { log('error', 'Devnet setup failed; check RPC, SOL faucet limits, mint deployment, program deployment and key paths. Secrets and upstream error bodies are suppressed.'); process.exitCode = 1; });
