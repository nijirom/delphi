import { type PublicKey } from '@solana/web3.js';
import { eventTickerFromSymbol, log, revealWindowClosed, type DelphiProgram, type ForecastAccount, type GeminiClient, type GeminiContract, type MarketAccount } from '@delphi/shared';

export type MarketRow = { pubkey: PublicKey; account: MarketAccount };
type SettlementDependencies = {
  client: Pick<DelphiProgram, 'fetchMarket'> & { resolveMarket(symbol: string, outcomeYes: boolean): Promise<string> };
  gemini: Pick<GeminiClient, 'recentlySettled' | 'getEvent'>;
  isStopping: () => boolean;
};
type ForfeitDependencies = {
  client: Pick<DelphiProgram, 'unscoredForecasts' | 'forfeitForecast' | 'fetchForecast'>;
  chainTime: () => Promise<number>;
  isStopping: () => boolean;
};
function settlementOutcome(contract: GeminiContract): boolean | undefined {
  if (!['settled', 'resolved'].includes(contract.status.toLowerCase())) return undefined;
  if (contract.resolutionSide === 'yes') return true;
  if (contract.resolutionSide === 'no') return false;
  return undefined;
}

/** The recent feed is an optimization, not a coverage boundary: recover older pending markets from their exact event. */
export async function resolveSettled(markets: readonly MarketRow[], { client, gemini, isStopping }: SettlementDependencies): Promise<number> {
  const pending = markets.filter(m => !m.account.resolved);
  if (pending.length === 0) return 0;
  let failures = 0;
  const settled = new Map<string, boolean>();
  try {
    for (const event of (await gemini.recentlySettled({ limit: 500 })).data) for (const contract of event.contracts) {
      const outcome = settlementOutcome(contract);
      if (outcome !== undefined) settled.set(contract.instrumentSymbol, outcome);
    }
  } catch { failures++; log('error', 'Recent settlement lookup failed'); }
  // At most one direct request per unmatched event per poll, including events with many on-chain contracts.
  const unmatched = new Map<string, string[]>();
  for (const { account } of pending) {
    const symbol = account.instrumentSymbol;
    if (settled.has(symbol)) continue;
    const ticker = eventTickerFromSymbol(symbol);
    const symbols = unmatched.get(ticker);
    if (symbols) symbols.push(symbol);
    else unmatched.set(ticker, [symbol]);
  }
  for (const [ticker, symbols] of unmatched) {
    if (isStopping()) return failures;
    try {
      const event = await gemini.getEvent(ticker);
      if (event.ticker !== ticker) throw new Error('Settlement event mismatch');
      for (const symbol of symbols) {
        const contract = event.contracts.find(c => c.instrumentSymbol === symbol);
        if (!contract) continue;
        const outcome = settlementOutcome(contract);
        if (outcome !== undefined) settled.set(symbol, outcome);
      }
    } catch { failures++; log('error', 'Event settlement lookup failed', { eventTicker: ticker }); }
  }
  for (const { account } of pending) {
    if (isStopping()) return failures;
    const outcome = settled.get(account.instrumentSymbol);
    if (outcome === undefined) continue;
    try { await client.resolveMarket(account.instrumentSymbol, outcome); log('info', 'Market resolved', { instrumentSymbol: account.instrumentSymbol }); }
    catch (e) {
      // Signers attest on their own schedule; too few signatures yet is a normal wait, not a resolver failure.
      const quorum = e instanceof Error ? /requires (\d+) independent attestations; found (\d+)/.exec(e.message) : null;
      if (quorum) { log('info', 'Awaiting settlement quorum', { instrumentSymbol: account.instrumentSymbol, required: Number(quorum[1]), found: Number(quorum[2]) }); continue; }
      const current = await client.fetchMarket(account.instrumentSymbol).catch(() => null);
      if (!current?.resolved || current.outcomeYes !== outcome) { failures++; log('error', 'Resolve failed; retrying next poll', { instrumentSymbol: account.instrumentSymbol, reason: e instanceof Error ? e.message : 'unknown' }); }
    }
  }
  return failures;
}

/** Close the free option for every forecaster, not just ours: unrevealed forecasts past the window are scored at the worst Brier. */
export async function forfeitSweep(markets: readonly MarketRow[], protect: ReadonlySet<string>, { client, chainTime, isStopping }: ForfeitDependencies): Promise<number> {
  let failures = 0, forfeited = 0;
  // The chain clock only moves forward between this read and the transaction, so a window closed here is closed when the program checks it.
  let now: number;
  try { now = await chainTime(); } catch { log('error', 'Chain clock unavailable; forfeit sweep skipped'); return 1; }
  const overdue = new Set<string>();
  for (const { pubkey, account } of markets) if (account.resolved && revealWindowClosed(account.resolvedAt, now)) overdue.add(pubkey.toBase58());
  if (overdue.size === 0) return 0;
  let open: { pubkey: PublicKey; account: ForecastAccount }[];
  try { open = await client.unscoredForecasts(); } catch { log('error', 'Forecast enumeration failed; forfeit sweep skipped'); return 1; }
  for (const { pubkey, account } of open) {
    if (isStopping()) return failures;
    const address = pubkey.toBase58();
    if (!overdue.has(account.market.toBase58()) || protect.has(address)) continue;
    try { await client.forfeitForecast(pubkey); forfeited++; }
    catch {
      const current = await client.fetchForecast(pubkey).catch(() => null);
      if (!current?.forfeited && !current?.revealed) { failures++; log('error', 'Forfeit failed; retrying next poll', { forecastPda: address }); }
    }
  }
  if (forfeited) log('info', 'Forfeited unrevealed forecasts', { forfeited });
  return failures;
}

/** Recover bonds when a third-party raw instruction scored without settling escrow. */
export async function settleBondSweep(client: Pick<DelphiProgram, 'allForecastBonds' | 'fetchForecast' | 'settleForecastBond'>, isStopping: () => boolean): Promise<number> {
  let failures = 0;
  let bonds;
  try { bonds = await client.allForecastBonds(); } catch { log('error', 'Bond enumeration failed'); return 1; }
  for (const { account } of bonds) {
    if (isStopping()) break;
    if (account.settled) continue;
    try {
      const forecast = await client.fetchForecast(account.forecast);
      if (forecast?.revealed || forecast?.forfeited) await client.settleForecastBond(account.forecast);
    } catch { failures++; log('error', 'Bond settlement failed; retrying next poll', { forecastPda: account.forecast.toBase58() }); }
  }
  return failures;
}
