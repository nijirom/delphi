import { mkdirSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction, type Connection } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, getMint } from '@solana/spl-token';
import { loadEnv, REPO_ROOT, connection, loadKeypair, DelphiProgram, pdas, log, validateSettlementPolicy } from '@delphi/shared';
import { slugs } from '@delphi/forecaster/strategy';

/** Operating wallets need ~0.3 SOL for fees and rent. The funded oracle pays first; the rate-limited devnet faucet is the fallback. */
async function topUp(conn: Connection, to: PublicKey, from?: Keypair): Promise<void> {
  const amount = Math.round(0.3 * LAMPORTS_PER_SOL);
  if (from && await conn.getBalance(from.publicKey, 'confirmed') > amount + LAMPORTS_PER_SOL / 2) {
    await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: amount })), [from], { commitment: 'confirmed' });
    log('info', 'Wallet funded from oracle', { publicKey: to.toBase58(), lamports: amount });
    return;
  }
  const signature = await conn.requestAirdrop(to, LAMPORTS_PER_SOL).catch(() => { throw new Error(`Devnet faucet refused ${to.toBase58()}; fund it (or the oracle) via faucet.solana.com and rerun`); });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const status = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (status?.err) throw new Error('SOL airdrop failed');
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return;
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error('SOL airdrop confirmation timed out; rerun setup');
}

async function main(): Promise<void> {
  const env = loadEnv();
  const conn = connection(env);
  const endpoint = new URL(env.SOLANA_RPC_URL);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  const genesis = await conn.getGenesisHash();
  const devnet = genesis === 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
  if (!devnet && !local) throw new Error('Setup only permits verified devnet or localhost RPC');
  if (genesis.startsWith('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp') || genesis.startsWith('4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z')) throw new Error('Mainnet and testnet are not permitted');
  const paths = [...new Set([env.DELPHI_ORACLE_KEYPAIR, env.BUYER_KEYPAIR, ...slugs.map(s => `keys/persona-${s}.json`)])];
  const wallets: Keypair[] = [];
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
    wallets.push(key);
    if (await conn.getBalance(key.publicKey, 'confirmed') < LAMPORTS_PER_SOL / 4) await topUp(conn, key.publicKey, paths.indexOf(name) > 0 ? loadKeypair(env.DELPHI_ORACLE_KEYPAIR) : undefined);
  }
  const oracle = loadKeypair(env.DELPHI_ORACLE_KEYPAIR);
  const mint = new PublicKey(env.USDC_MINT);
  const mintAccount = await getMint(conn, mint, 'confirmed');
  if (mintAccount.decimals !== 6) throw new Error('Configured USDC mint must have six decimals');
  for (const key of wallets) {
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
  const signerKeys = (process.env.SETTLEMENT_SIGNERS || '').split(',').map(s => s.trim()).filter(Boolean).map(s => new PublicKey(s));
  const threshold = Number(process.env.SETTLEMENT_THRESHOLD || '2');
  const policy = await client.fetchSettlementConfig();
  if (!policy && !signerKeys.length) {
    log('warn', 'SETTLEMENT_SIGNERS unset; markets cannot resolve until a settlement quorum is initialized');
  } else if (!policy) {
    validateSettlementPolicy({ threshold, signers: signerKeys });
    await client.initializeSettlement(threshold, signerKeys);
  } else if (signerKeys.length && (policy.threshold !== threshold || policy.signers.map(s => s.toBase58()).join(',') !== signerKeys.map(s => s.toBase58()).join(','))) {
    throw new Error('Immutable settlement policy differs from configuration');
  }
  const treasuryAddress = process.env.BOND_TREASURY_TOKEN_ACCOUNT;
  const bonds = await client.fetchBondConfig();
  if (treasuryAddress) {
    const treasury = new PublicKey(treasuryAddress);
    if (!bonds) await client.initializeBonds(mint, treasury);
    else if (!bonds.mint.equals(mint) || !bonds.treasury.equals(treasury)) throw new Error('Immutable bond configuration differs from configuration');
  } else if (BigInt(process.env.FORECAST_BOND_MICRO_USDC || '0') > 0n && !bonds) {
    throw new Error('BOND_TREASURY_TOKEN_ACCOUNT is required before bonded publishing');
  }
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
// Only our own messages are echoed; RPC and upstream error bodies may carry URLs with credentials.
const actionable = /^(Devnet faucet refused|SOL airdrop|Setup only permits|Mainnet and testnet|Configured USDC mint|Immutable |BOND_TREASURY_TOKEN_ACCOUNT|Settlement policy|Persona )/;
main().catch((e: unknown) => { log('error', e instanceof Error && actionable.test(e.message) ? e.message : 'Devnet setup failed; check RPC, SOL faucet limits, mint deployment, program deployment and key paths. Secrets and upstream error bodies are suppressed.'); process.exitCode = 1; });
