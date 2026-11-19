import { readSettlementAttestations, type DelphiProgram } from '@delphi/shared';

/** This process only relays independently supplied signatures; its fee-payer key is not a vote. */
export async function resolveAttestedMarket(client: DelphiProgram, symbol: string, outcomeYes: boolean, directory: string): Promise<string> {
  const policy = await client.fetchSettlementConfig();
  if (!policy) throw new Error('Settlement quorum is not initialized');
  const attestations = await readSettlementAttestations(directory, client.settlementBinding(symbol, outcomeYes), policy);
  return client.resolveMarket(symbol, outcomeYes, attestations);
}
