import anchor from '@coral-xyz/anchor';
import type { Idl } from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { readFileSync } from 'node:fs';
import { log } from '@delphi/shared';
import { eventKind, normalizePayload, tokenReceipts, type Row } from './input.js';
import { Store, type NewEvent, type StoredEvent } from './store.js';
const { Program, AnchorProvider, BorshCoder, EventParser } = anchor;
type AccountRow = { publicKey: PublicKey; account: Record<string, unknown> };
export type ForecastSnapshot = { pubkey: string; forecaster: string; market: string; pricePerRead: number; postedAt: number; reads: number; revealed: boolean; forfeited: boolean; probBps: number; brierBps: number };
export type MarketSnapshot = { resolved: boolean; outcomeYes: boolean; resolvedAt: number };
export type BondSnapshot = { amountMicro: number; settled: boolean; slashed: boolean };
type AccountClient = { size: number; all(filters?: { dataSize: number }[]): Promise<AccountRow[]> };
export type RpcHealth = {
  recipientHistoryFailures: number;
  recipientHistoryFailuresThisPoll: number;
  failedRecipientAddresses: string[];
  lastRecipientHistoryFailureAt: number | null;
  droppedSignatures: number;
  lastDroppedSignature: { signature: string; address: string; at: number } | null;
};
function storedCount(store: Store, key: string): number {
  const value = Number(store.get(key) ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function storedDrop(store: Store): RpcHealth['lastDroppedSignature'] {
  try {
    const value = JSON.parse(store.get('rpcLastDroppedSignature') ?? 'null') as RpcHealth['lastDroppedSignature'];
    return value && typeof value.signature === 'string' && typeof value.address === 'string' && Number.isSafeInteger(value.at) ? value : null;
  } catch { return null; }
}
export function usdcTransferEvents(receipts: { owner: string; amount: bigint }[], entries: readonly NewEvent[], forecasterOwners: ReadonlyMap<string, string>, mint: string, hasBondSettlement = false): NewEvent[] {
  const purchaseTotals = new Map<string, bigint>();
  for (const entry of entries) {
    if (entry.kind !== 'purchase_recorded') continue;
    const owner = forecasterOwners.get(String(entry.data.forecaster));
    const amount = String(entry.data.amount);
    if (!owner || !/^\d+$/.test(amount) || BigInt(amount) === 0n) continue;
    purchaseTotals.set(owner, (purchaseTotals.get(owner) ?? 0n) + BigInt(amount));
  }
  return receipts.map(receipt => {
    // Exact equality avoids crediting an unrelated transfer bundled beside a purchase.
    const earned = !hasBondSettlement && purchaseTotals.get(receipt.owner) === receipt.amount;
    return { kind: 'usdc_transfer', data: {
      owner: receipt.owner, mint, amountBaseUnits: receipt.amount.toString(), amountUsdc: Number(receipt.amount) / 1e6,
      earned, attribution: earned ? 'record_purchase_same_transaction' : 'unattributed_balance_increase',
    } };
  });
}
/** Accounts written by a previous program layout have a different size and cannot be decoded; one such account would otherwise fail the whole snapshot. Only valid for accounts without `String` fields: Anchor's IDL `size` counts a string as 4 bytes, not its `max_len`. */
function current(client: AccountClient): Promise<AccountRow[]> { return client.all([{ dataSize: client.size }]); }
function text(x: unknown): string { return x instanceof PublicKey ? x.toBase58() : String(x); }
function json(x: unknown): unknown {
  if (x instanceof PublicKey) return x.toBase58();
  if (anchor.BN.isBN(x)) return String(x);
  if (typeof x === 'bigint') return x.toString();
  if (Buffer.isBuffer(x) || x instanceof Uint8Array) return Buffer.from(x).toString('hex');
  if (Array.isArray(x)) return x.map(json);
  if (x !== null && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, json(v)]));
  return x;
}
export class ChainIndexer {
  readonly rpc: Connection;
  readonly program: InstanceType<typeof Program>;
  readonly parser: InstanceType<typeof EventParser>;
  owners = new Set<string>();
  forecasterOwners = new Map<string, string>();
  symbols = new Map<string, string>();
  forecastMarkets = new Map<string, string>();
  forecasts: ForecastSnapshot[] = [];
  markets = new Map<string, MarketSnapshot>();
  /** Keyed by forecast PDA. Empty when the deployed program predates bonds. */
  bonds = new Map<string, BondSnapshot>();
  ready = false;
  private recipientHistoryFailures = 0;
  private recipientHistoryFailuresThisPoll = 0;
  private failedRecipientAddresses: string[] = [];
  private lastRecipientHistoryFailureAt: number | null = null;
  private droppedSignatures = 0;
  private lastDroppedSignature: RpcHealth['lastDroppedSignature'] = null;
  constructor(readonly store: Store, readonly programId: PublicKey, rpcUrl: string, idlPath: string, readonly mint: string, readonly publish: (event: StoredEvent) => void) {
    this.recipientHistoryFailures = storedCount(store, 'rpcRecipientHistoryFailures');
    this.lastRecipientHistoryFailureAt = Number(store.get('rpcLastRecipientHistoryFailureAt') ?? 0) || null;
    this.droppedSignatures = storedCount(store, 'rpcDroppedSignatures');
    this.lastDroppedSignature = storedDrop(store);
    this.rpc = new Connection(rpcUrl, 'confirmed');
    const idl = JSON.parse(readFileSync(idlPath, 'utf8')) as Idl;
    idl.address = programId.toBase58();
    // Read-only wallet: no keypair is loaded or generated; signing always fails closed.
    const provider = new AnchorProvider(this.rpc, {
      publicKey: PublicKey.default,
      signTransaction: async () => { throw new Error('Read-only provider'); },
      signAllTransactions: async () => { throw new Error('Read-only provider'); }
    }, { commitment: 'confirmed' });
    this.program = new Program(idl, provider);
    this.parser = new EventParser(programId, new BorshCoder(this.program.idl));
  }
  async refresh(): Promise<void> {
    const accounts = this.program.account as unknown as Record<string, AccountClient>;
    if (!accounts.forecaster || !accounts.market) throw new Error('IDL missing forecaster or market account');
    // Sequential: public RPCs throttle concurrent getProgramAccounts calls from one client.
    const forecasters = await accounts.forecaster.all();
    const markets = await accounts.market.all();
    const forecasts = await current(accounts.forecast);
    const bonds = accounts.forecastBond ? await current(accounts.forecastBond) : [];
    const snapshot = forecasters.map(({ publicKey, account: a }) => ({ forecasterPda: publicKey.toBase58(), authority: text(a.authority), name: text(a.name), reputationBps: Number(a.reputationBps), scoredCount: Number(a.scoredCount), totalReads: Number(a.totalReads) }));
    if (snapshot.some(r => !Number.isFinite(r.reputationBps) || !Number.isFinite(r.scoredCount) || !Number.isFinite(r.totalReads))) throw new Error('Invalid chain snapshot');
    this.store.snapshot(snapshot);
    this.owners = new Set(snapshot.map(r => r.authority));
    this.forecasterOwners = new Map(snapshot.map(r => [r.forecasterPda, r.authority]));
    this.symbols = new Map(markets.map(({ publicKey, account }) => [publicKey.toBase58(), text(account.instrumentSymbol)]));
    this.markets = new Map(markets.map(({ publicKey, account }) => [publicKey.toBase58(), { resolved: Boolean(account.resolved), outcomeYes: Boolean(account.outcomeYes), resolvedAt: Number(account.resolvedAt) }]));
    this.forecasts = forecasts.map(({ publicKey, account: a }) => ({ pubkey: publicKey.toBase58(), forecaster: text(a.forecaster), market: text(a.market), pricePerRead: Number(a.pricePerRead), postedAt: Number(a.postedAt), reads: Number(a.reads), revealed: Boolean(a.revealed), forfeited: Boolean(a.forfeited), probBps: Number(a.probBps), brierBps: Number(a.brierBps) }));
    this.forecastMarkets = new Map(this.forecasts.map(f => [f.pubkey, f.market]));
    this.bonds = new Map(bonds.map(({ account: a }) => [text(a.forecast), { amountMicro: Number(a.amount), settled: Boolean(a.settled), slashed: Boolean(a.slashed) }]));
    this.ready = true;
  }
  ingest(row: Row): void {
    if (!this.ready) throw new Error('Snapshot unavailable');
    if (this.store.has(row.signature)) return;
    if (row.err !== null) { this.store.ingest(row, []); return; }
    const entries: NewEvent[] = [];
    let hasBondSettlement = false;
    // EventParser tracks CPI invocation stacks and only decodes this program's logs.
    for (const event of this.parser.parseLogs(row.logMessages)) {
      if (event.name.replaceAll('_', '').toLowerCase() === 'bondsettled') { hasBondSettlement = true; continue; }
      const kind = eventKind(event.name);
      if (!kind) continue;
      const data = json(event.data) as Record<string, unknown>;
      const symbol = this.symbols.get(String(data.market ?? this.forecastMarkets.get(String(data.forecast))));
      if (symbol) data.instrumentSymbol = symbol;
      entries.push({ kind, data });
    }
    for (const event of usdcTransferEvents(tokenReceipts(row, this.mint, this.owners), entries, this.forecasterOwners, this.mint, hasBondSettlement)) entries.push(event);
    for (const event of this.store.ingest(row, entries)) this.publish(event);
  }
  rpcHealth(): RpcHealth {
    return {
      recipientHistoryFailures: this.recipientHistoryFailures,
      recipientHistoryFailuresThisPoll: this.recipientHistoryFailuresThisPoll,
      failedRecipientAddresses: [...this.failedRecipientAddresses],
      lastRecipientHistoryFailureAt: this.lastRecipientHistoryFailureAt,
      droppedSignatures: this.droppedSignatures,
      lastDroppedSignature: this.lastDroppedSignature,
    };
  }
  static readonly MAX_TRANSACTIONS_PER_POLL = 100;
  private async signatures(address: PublicKey, until: string | undefined): Promise<{ signature: string; slot: number }[]> {
    let before: string | undefined;
    const found: { signature: string; slot: number }[] = [];
    for (;;) {
      const page = await this.rpc.getSignaturesForAddress(address, { limit: 1000, ...(before ? { before } : {}), ...(until ? { until } : {}) }, 'confirmed');
      if (!page.length) break;
      for (const s of page) {
        if (s.confirmationStatus !== 'confirmed' && s.confirmationStatus !== 'finalized') throw new Error('RPC returned an unconfirmed signature');
        found.push({ signature: s.signature, slot: s.slot });
      }
      before = page.at(-1)!.signature;
      if (page.length < 1000) break;
    }
    return found;
  }
  async poll(): Promise<void> {
    this.recipientHistoryFailuresThisPoll = 0;
    this.failedRecipientAddresses = [];
    // x402 transfers do not invoke Delphi. Index recipient ATAs as well as the program.
    const addresses = [this.programId, ...[...this.owners].map(owner =>
      getAssociatedTokenAddressSync(new PublicKey(this.mint), new PublicKey(owner)))];
    for (const address of addresses) {
      const cursorKey = `rpcCursor:${address.toBase58()}`, pendingKey = `rpcPending:${address.toBase58()}`;
      const until = this.store.get(cursorKey);
      let signatures: { signature: string; slot: number }[];
      try { signatures = await this.signatures(address, until); }
      catch (error) {
        try {
          // A pruned cursor transaction makes `until` unusable; rescan from the tip. Dedup makes this safe.
          if (until && /not found/i.test(String(error))) signatures = await this.signatures(address, undefined);
          else throw error;
        } catch (finalError) {
          // The program's own history gates health; a throttled recipient ATA retries next cycle without blocking it.
          if (address.equals(this.programId)) throw finalError;
          const key = address.toBase58(), at = Date.now();
          this.recipientHistoryFailures++;
          this.recipientHistoryFailuresThisPoll++;
          this.failedRecipientAddresses.push(key);
          this.lastRecipientHistoryFailureAt = at;
          this.store.set('rpcRecipientHistoryFailures', String(this.recipientHistoryFailures));
          this.store.set('rpcLastRecipientHistoryFailureAt', String(at));
          log('warn', 'Recipient history unavailable this cycle', { address: key });
          continue;
        }
      }
      // Transactions the RPC could not return yet are retried on later polls instead of blocking the cursor.
      // Every queued signature is persisted before the cursor moves, so a throttled poll resumes instead of restarting.
      const pending = JSON.parse(this.store.get(pendingKey) ?? '[]') as { signature: string; attempts: number }[];
      const retry = new Map(pending.map(p => [p.signature, p.attempts]));
      const newest = signatures[0]?.signature;
      const queue = [...new Set([...pending.map(p => p.signature), ...signatures.reverse().map(s => s.signature)])];
      const unresolved: { signature: string; attempts: number }[] = [];
      let fetched = 0;
      for (const signature of queue) {
        if (this.store.has(signature)) continue;
        const attempts = retry.get(signature) ?? 0;
        // Bounded work per poll; the remainder waits in the durable queue.
        if (fetched >= ChainIndexer.MAX_TRANSACTIONS_PER_POLL) { unresolved.push({ signature, attempts }); continue; }
        fetched++;
        let tx;
        // A throttled or failed request is not evidence the transaction is missing; it does not count toward dropping it.
        try { tx = await this.rpc.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); }
        catch { unresolved.push({ signature, attempts }); continue; }
        if (!tx) {
          if (attempts + 1 <= 5) unresolved.push({ signature, attempts: attempts + 1 });
          else {
            const dropped = { signature, address: address.toBase58(), at: Date.now() };
            this.droppedSignatures++;
            this.lastDroppedSignature = dropped;
            this.store.set('rpcDroppedSignatures', String(this.droppedSignatures));
            this.store.set('rpcLastDroppedSignature', JSON.stringify(dropped));
            log('warn', 'Dropped unresolvable signature after retries', { signature, address: dropped.address });
          }
          continue;
        }
        for (const row of normalizePayload(tx)) this.ingest(row);
      }
      this.store.set(pendingKey, JSON.stringify(unresolved));
      if (newest) this.store.set(cursorKey, newest);
    }
    this.store.set('rpcPollAt', String(Date.now()));
  }
}
