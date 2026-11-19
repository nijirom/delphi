import anchor from '@coral-xyz/anchor';
import type { Idl, Program as ProgramType } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction, type TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { settlementInstructions, validateSettlementPolicy, type SettlementAttestation, type SettlementBinding } from './attestations.js';
export * from './attestations.js';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, type Env } from './config.js';
const { Program, AnchorProvider, Wallet, BN, BorshCoder, EventParser } = anchor;
export { BorshCoder, EventParser };
export type ForecasterAccount = { authority: PublicKey; name: string; pricePerRead: bigint; totalForecasts: number; totalReads: number; scoredCount: number; brierSumBps: bigint; reputationBps: number };
export type ForecastAccount = { forecaster: PublicKey; market: PublicKey; commitment: Uint8Array; pricePerRead: bigint; postedAt: number; reads: number; revealed: boolean; forfeited: boolean; probBps: number; brierBps: number };
/** Mirrors the program's `REVEAL_WINDOW_SECS`: seconds after resolution before anyone may forfeit an unrevealed forecast. */
export const REVEAL_WINDOW_SECS = 3600;
/** Both arguments are unix seconds on the chain clock. Non-integers are not treated as elapsed, so a bad timestamp cannot open the window. */
export function revealWindowClosed(resolvedAt: number, now: number): boolean {
  if (!Number.isSafeInteger(resolvedAt) || !Number.isSafeInteger(now)) return false;
  return now >= resolvedAt + REVEAL_WINDOW_SECS;
}
/** `Clock::unix_timestamp` as the program sees it. Wall time is not a substitute: a local test validator's clock can lag by hours. */
export async function chainTime(conn: Connection): Promise<number> {
  const info = await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed');
  if (!info || info.data.length < 40) throw new Error('Clock sysvar unavailable');
  return Number(info.data.readBigInt64LE(32));
}
export type MarketAccount = { marketHash: Uint8Array; instrumentSymbol: string; resolved: boolean; outcomeYes: boolean; resolvedAt: number };
export type SettlementConfigAccount = { threshold: number; signers: PublicKey[] };
export type BondConfigAccount = { mint: PublicKey; treasury: PublicKey };
export type ForecastBondAccount = { forecast: PublicKey; depositor: PublicKey; refundAccount: PublicKey; amount: bigint; settled: boolean; slashed: boolean };
export function loadKeypair(path: string): Keypair {
  let bytes: unknown;
  try { bytes = JSON.parse(readFileSync(resolve(REPO_ROOT, path), 'utf8')); } catch { throw new Error('Unable to read Solana keypair file'); }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error('Solana keypair must contain 64 bytes');
  try { return Keypair.fromSecretKey(Uint8Array.from(bytes)); } catch { throw new Error('Invalid Solana keypair'); }
}
export function connection(env: Env): Connection { return new Connection(env.SOLANA_RPC_URL, 'confirmed'); }
export function marketHash(instrumentSymbol: string): Uint8Array { return createHash('sha256').update(instrumentSymbol, 'utf8').digest(); }
function bytes(value: Uint8Array, length: number): Buffer { if (value.length !== length) throw new RangeError(`Expected ${length} bytes`); return Buffer.from(value); }
export function commitment(probBps: number, salt: Uint8Array): Uint8Array {
  if (!Number.isInteger(probBps) || probBps < 0 || probBps > 10000) throw new RangeError('Invalid probability basis points');
  const p = Buffer.alloc(2); p.writeUInt16LE(probBps);
  return createHash('sha256').update(p).update(bytes(salt, 32)).digest();
}
export function randomSalt(): Uint8Array { return randomBytes(32); }
export function pdas(programId: PublicKey) {
  const derive = (tag: string, ...seeds: Buffer[]) => PublicKey.findProgramAddressSync([Buffer.from(tag), ...seeds], programId)[0];
  return {
    config: () => derive('config'), forecaster: (auth: PublicKey) => derive('forecaster', auth.toBuffer()),
    market: (hash: Uint8Array) => derive('market', bytes(hash, 32)),
    forecast: (forecasterPda: PublicKey, hash: Uint8Array) => derive('forecast', forecasterPda.toBuffer(), bytes(hash, 32)),
    purchase: (forecastPda: PublicKey, buyer: PublicKey) => derive('purchase', forecastPda.toBuffer(), buyer.toBuffer()),
    settlementConfig: () => derive('settlement_config'), bondConfig: () => derive('bond_config'),
    forecastBond: (forecastPda: PublicKey) => derive('forecast_bond', forecastPda.toBuffer()),
    bondVault: (forecastPda: PublicKey) => derive('bond_vault', forecastPda.toBuffer()),
  };
}
type Raw = Record<string, unknown>;
type Builder = { accountsStrict(accounts: Record<string, PublicKey>): { rpc(): Promise<string>; instruction(): Promise<TransactionInstruction> } };
type Methods = Record<string, (...args: unknown[]) => Builder>;
function integer(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'object' && value !== null && BN.isBN(value)) return BigInt(value.toString());
  throw new Error('Invalid on-chain integer');
}
function number(value: unknown): number { const n = Number(integer(value)); if (!Number.isSafeInteger(n)) throw new Error('Unsafe on-chain integer'); return n; }
function key(value: unknown): PublicKey { if (!(value instanceof PublicKey)) throw new Error('Invalid on-chain public key'); return value; }
function text(value: unknown): string { if (typeof value !== 'string') throw new Error('Invalid on-chain string'); return value; }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') throw new Error('Invalid on-chain boolean'); return value; }
function array(value: unknown): Uint8Array { if (!Array.isArray(value) && !(value instanceof Uint8Array)) throw new Error('Invalid on-chain bytes'); return bytes(Uint8Array.from(value), 32); }
function forecaster(a: Raw): ForecasterAccount { return { authority: key(a.authority), name: text(a.name), pricePerRead: integer(a.pricePerRead), totalForecasts: number(a.totalForecasts), totalReads: number(a.totalReads), scoredCount: number(a.scoredCount), brierSumBps: integer(a.brierSumBps), reputationBps: number(a.reputationBps) }; }
function forecast(a: Raw): ForecastAccount { return { forecaster: key(a.forecaster), market: key(a.market), commitment: array(a.commitment), pricePerRead: integer(a.pricePerRead), postedAt: number(a.postedAt), reads: number(a.reads), revealed: bool(a.revealed), forfeited: bool(a.forfeited), probBps: number(a.probBps), brierBps: number(a.brierBps) }; }
function market(a: Raw): MarketAccount { return { marketHash: array(a.marketHash), instrumentSymbol: text(a.instrumentSymbol), resolved: bool(a.resolved), outcomeYes: bool(a.outcomeYes), resolvedAt: number(a.resolvedAt) }; }
function settlementConfig(a: Raw): SettlementConfigAccount {
  if (!Array.isArray(a.signers)) throw new Error('Invalid settlement signer list');
  const policy = { threshold: number(a.threshold), signers: a.signers.map(key) };
  validateSettlementPolicy(policy);
  return policy;
}
function bondConfig(a: Raw): BondConfigAccount { return { mint: key(a.mint), treasury: key(a.treasury) }; }
function forecastBond(a: Raw): ForecastBondAccount {
  return { forecast: key(a.forecast), depositor: key(a.depositor), refundAccount: key(a.refundAccount), amount: integer(a.amount), settled: bool(a.settled), slashed: bool(a.slashed) };
}
function u64(value: bigint): InstanceType<typeof BN> { if (value < 0n || value > 18446744073709551615n) throw new RangeError('Value outside u64'); return new BN(value.toString()); }
export class DelphiProgram {
  readonly provider: InstanceType<typeof AnchorProvider>;
  readonly program: ProgramType<Idl>;
  readonly idl: Idl;
  readonly programId: PublicKey;
  private readonly addresses: ReturnType<typeof pdas>;
  private readonly authority: PublicKey;
  constructor(conn: Connection, wallet: Keypair, programId: PublicKey, idlPath = 'packages/shared/idl/delphi.json') {
    this.programId = programId; this.authority = wallet.publicKey; this.addresses = pdas(programId);
    let idl: Idl;
    try { idl = JSON.parse(readFileSync(resolve(REPO_ROOT, idlPath), 'utf8')) as Idl; } catch { throw new Error('Cannot load Delphi IDL; build the program and copy target/idl/delphi.json into packages/shared/idl'); }
    if (!Array.isArray(idl.instructions) || !Array.isArray(idl.accounts)) throw new Error('Invalid Delphi IDL');
    this.idl = { ...idl, address: programId.toBase58() };
    this.provider = new AnchorProvider(conn, new Wallet(wallet), { commitment: 'confirmed', preflightCommitment: 'confirmed' });
    this.program = new Program(this.idl, this.provider);
  }
  private send(name: string, args: unknown[], accounts: Record<string, PublicKey>): Promise<string> {
    const fn = (this.program.methods as unknown as Methods)[name];
    if (!fn) throw new Error(`IDL lacks instruction ${name}`);
    return fn(...args).accountsStrict(accounts).rpc();
  }
  private instruction(name: string, args: unknown[], accounts: Record<string, PublicKey>): Promise<TransactionInstruction> {
    const fn = (this.program.methods as unknown as Methods)[name];
    if (!fn) throw new Error(`IDL lacks instruction ${name}; rebuild and sync the program IDL`);
    return fn(...args).accountsStrict(accounts).instruction();
  }
  private sendInstructions(instructions: TransactionInstruction[]): Promise<string> {
    return this.provider.sendAndConfirm(new Transaction().add(...instructions), []);
  }
  private async fetch<T>(name: string, address: PublicKey, decode: (a: Raw) => T): Promise<T | null> {
    const info = await this.provider.connection.getAccountInfo(address, 'confirmed');
    if (info === null) return null;
    if (!info.owner.equals(this.programId)) throw new Error('Account is not owned by Delphi program');
    return decode(this.program.coder.accounts.decode(name, info.data) as Raw);
  }
  private async all<T>(name: string, decode: (a: Raw) => T): Promise<{ pubkey: PublicKey; account: T }[]> {
    const clients = this.program.account as unknown as Record<string, { all(): Promise<{ publicKey: PublicKey; account: Raw }[]> }>;
    if (!clients[name]) throw new Error(`IDL lacks account ${name}`);
    return (await clients[name].all()).map(row => ({ pubkey: row.publicKey, account: decode(row.account) }));
  }
  initialize(): Promise<string> { return this.send('initialize', [], { config: this.addresses.config(), authority: this.authority, systemProgram: SystemProgram.programId }); }
  initializeSettlement(threshold: number, signers: PublicKey[]): Promise<string> {
    validateSettlementPolicy({ threshold, signers });
    return this.send('initializeSettlement', [threshold, signers], { config: this.addresses.config(), settlementConfig: this.addresses.settlementConfig(), authority: this.authority, systemProgram: SystemProgram.programId });
  }
  initializeBonds(mint: PublicKey, treasury: PublicKey): Promise<string> {
    return this.send('initializeBonds', [], { config: this.addresses.config(), bondConfig: this.addresses.bondConfig(), authority: this.authority, mint, treasury, systemProgram: SystemProgram.programId });
  }
  settlementBinding(instrumentSymbol: string, outcomeYes: boolean): SettlementBinding {
    return { programId: this.programId, config: this.addresses.settlementConfig(), market: this.addresses.market(marketHash(instrumentSymbol)), outcomeYes };
  }
  registerForecaster(name: string, pricePerRead: bigint): Promise<string> {
    if (Buffer.byteLength(name) > 32) throw new RangeError('Forecaster name exceeds 32 bytes');
    return this.send('registerForecaster', [name, u64(pricePerRead)], { forecaster: this.addresses.forecaster(this.authority), authority: this.authority, systemProgram: SystemProgram.programId });
  }
  updateForecaster(pricePerRead: bigint): Promise<string> { return this.send('updateForecaster', [u64(pricePerRead)], { forecaster: this.addresses.forecaster(this.authority), authority: this.authority }); }
  async initMarket(instrumentSymbol: string): Promise<string> {
    if (Buffer.byteLength(instrumentSymbol) > 64) throw new RangeError('Symbol exceeds 64 bytes');
    if (await this.fetchMarket(instrumentSymbol)) return '';
    try { return await this.send('initMarket', [instrumentSymbol], { market: this.addresses.market(marketHash(instrumentSymbol)), payer: this.authority, systemProgram: SystemProgram.programId }); }
    catch (error) { if (await this.fetchMarket(instrumentSymbol)) return ''; throw error; }
  }
  async postForecast(instrumentSymbol: string, hash: Uint8Array, options: { bondAmount?: bigint } = {}): Promise<string> {
    const forecaster = this.addresses.forecaster(this.authority), mh = marketHash(instrumentSymbol);
    const forecast = this.addresses.forecast(forecaster, mh), market = this.addresses.market(mh);
    const post = await this.instruction('postForecast', [Array.from(bytes(hash, 32))], { forecast, forecaster, market, authority: this.authority, systemProgram: SystemProgram.programId });
    const amount = options.bondAmount ?? 0n;
    if (amount < 0n) throw new RangeError('Bond amount must be nonnegative');
    return this.sendInstructions(amount > 0n ? [post, await this.bondInstruction(forecast, forecaster, market, amount)] : [post]);
  }
  async recordPurchase(forecastPda: PublicKey, amount: bigint, paymentSig: Uint8Array): Promise<string> {
    const f = await this.fetchForecast(forecastPda); if (!f) throw new Error('Forecast account does not exist');
    return this.send('recordPurchase', [u64(amount), Array.from(bytes(paymentSig, 64))], { purchase: this.addresses.purchase(forecastPda, this.authority), forecast: forecastPda, forecaster: f.forecaster, market: f.market, buyer: this.authority, systemProgram: SystemProgram.programId });
  }
  async resolveMarket(instrumentSymbol: string, outcomeYes: boolean, attestations: readonly SettlementAttestation[]): Promise<string> {
    const policy = await this.fetchSettlementConfig();
    if (!policy) throw new Error('Settlement quorum is not initialized; no single-key resolution is supported');
    const binding = this.settlementBinding(instrumentSymbol, outcomeYes);
    const proofs = settlementInstructions(attestations, binding, policy);
    return this.sendInstructions([...proofs, await this.instruction('resolveMarket', [outcomeYes], {
      settlementConfig: binding.config, market: binding.market, instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
    })]);
  }
  async revealAndScore(forecastPda: PublicKey, probBps: number, salt: Uint8Array): Promise<string> {
    commitment(probBps, salt);
    const f = await this.fetchForecast(forecastPda); if (!f) throw new Error('Forecast account does not exist');
    const reveal = await this.instruction('revealAndScore', [probBps, Array.from(bytes(salt, 32))], { forecast: forecastPda, forecaster: f.forecaster, market: f.market });
    const settle = await this.bondSettlementInstruction(forecastPda, false);
    return this.sendInstructions(settle ? [reveal, settle] : [reveal]);
  }
  /** Permissionless. Scores an unrevealed forecast at the worst Brier once `REVEAL_WINDOW_SECS` have passed since resolution. */
  async forfeitForecast(forecastPda: PublicKey): Promise<string> {
    const f = await this.fetchForecast(forecastPda); if (!f) throw new Error('Forecast account does not exist');
    const forfeit = await this.instruction('forfeitForecast', [], { forecast: forecastPda, forecaster: f.forecaster, market: f.market });
    const settle = await this.bondSettlementInstruction(forecastPda, true);
    return this.sendInstructions(settle ? [forfeit, settle] : [forfeit]);
  }
  private async bondInstruction(forecast: PublicKey, forecaster: PublicKey, market: PublicKey, amount: bigint): Promise<TransactionInstruction> {
    if (amount <= 0n) throw new RangeError('Bond amount must be positive');
    const config = await this.fetchBondConfig();
    if (!config) throw new Error('Forecast bonds are not initialized');
    return this.instruction('bondForecast', [u64(amount)], { authority: this.authority, bondConfig: this.addresses.bondConfig(), forecaster, market, forecast,
      forecastBond: this.addresses.forecastBond(forecast), mint: config.mint, source: getAssociatedTokenAddressSync(config.mint, this.authority),
      vault: this.addresses.bondVault(forecast), tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId });
  }
  async bondForecast(forecast: PublicKey, amount: bigint): Promise<string> {
    const f = await this.fetchForecast(forecast);
    if (!f) throw new Error('Forecast account does not exist');
    return this.sendInstructions([await this.bondInstruction(forecast, f.forecaster, f.market, amount)]);
  }
  private async bondSettlementInstruction(forecast: PublicKey, slashed: boolean): Promise<TransactionInstruction | null> {
    const bond = await this.fetchForecastBond(forecast);
    if (!bond || bond.settled) return null;
    const config = await this.fetchBondConfig();
    if (!config) throw new Error('Bond configuration is missing');
    return this.instruction('settleForecastBond', [], { bondConfig: this.addresses.bondConfig(), forecast, forecastBond: this.addresses.forecastBond(forecast),
      mint: config.mint, vault: this.addresses.bondVault(forecast), recipient: slashed ? config.treasury : bond.refundAccount, tokenProgram: TOKEN_PROGRAM_ID });
  }
  /** Permissionless recovery when a raw on-chain reveal/forfeit omitted the escrow settlement instruction. */
  async settleForecastBond(forecast: PublicKey): Promise<string> {
    const f = await this.fetchForecast(forecast);
    if (!f || (!f.revealed && !f.forfeited)) throw new Error('Forecast is not terminal');
    const settle = await this.bondSettlementInstruction(forecast, f.forfeited);
    return settle ? this.sendInstructions([settle]) : '';
  }
  fetchSettlementConfig(): Promise<SettlementConfigAccount | null> { return this.fetch('settlementConfig', this.addresses.settlementConfig(), settlementConfig); }
  fetchBondConfig(): Promise<BondConfigAccount | null> { return this.fetch('bondConfig', this.addresses.bondConfig(), bondConfig); }
  fetchForecastBond(forecast: PublicKey): Promise<ForecastBondAccount | null> { return this.fetch('forecastBond', this.addresses.forecastBond(forecast), forecastBond); }
  allForecastBonds(): Promise<{ pubkey: PublicKey; account: ForecastBondAccount }[]> { return this.all('forecastBond', forecastBond); }
  fetchForecaster(auth: PublicKey): Promise<ForecasterAccount | null> { return this.fetch('forecaster', this.addresses.forecaster(auth), forecaster); }
  fetchForecast(pda: PublicKey): Promise<ForecastAccount | null> { return this.fetch('forecast', pda, forecast); }
  fetchMarket(symbol: string): Promise<MarketAccount | null> { return this.fetch('market', this.addresses.market(marketHash(symbol)), market); }
  async hasPurchase(forecastPda: PublicKey, buyer = this.authority): Promise<boolean> {
    const info = await this.provider.connection.getAccountInfo(this.addresses.purchase(forecastPda, buyer), 'confirmed');
    if (info === null) return false;
    if (!info.owner.equals(this.programId)) throw new Error('Account is not owned by Delphi program');
    return true;
  }
  allForecasters(): Promise<{ pubkey: PublicKey; account: ForecasterAccount }[]> { return this.all('forecaster', forecaster); }
  allMarkets(): Promise<{ pubkey: PublicKey; account: MarketAccount }[]> { return this.all('market', market); }
  /** Every forecast with `revealed == false && forfeited == false`, in one query. Filters on the two adjacent bools after `reads`. The size filter excludes accounts written by a previous layout; those cannot be forfeited by this program either. */
  async unscoredForecasts(): Promise<{ pubkey: PublicKey; account: ForecastAccount }[]> {
    const clients = this.program.account as unknown as Record<string, { size: number; all(filters: ({ memcmp: { offset: number; bytes: string } } | { dataSize: number })[]): Promise<{ publicKey: PublicKey; account: Raw }[]> }>;
    const rows = await clients.forecast.all([{ dataSize: clients.forecast.size }, { memcmp: { offset: 8 + 32 + 32 + 32 + 8 + 8 + 4, bytes: anchor.utils.bytes.bs58.encode(Uint8Array.of(0, 0)) } }]);
    return rows.map(row => ({ pubkey: row.publicKey, account: forecast(row.account) }));
  }
}
