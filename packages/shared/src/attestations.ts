import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ed25519Program, Keypair, PublicKey, type TransactionInstruction } from '@solana/web3.js';

export type SettlementAttestation = {
  programId: string; config: string; market: string; outcomeYes: boolean;
  signer: string; signature: string;
};
export type SettlementPolicy = { threshold: number; signers: PublicKey[] };
export type SettlementBinding = { programId: PublicKey; config: PublicKey; market: PublicKey; outcomeYes: boolean };
const DOMAIN = Buffer.from('delphi:settlement:v1');

export function settlementMessage(binding: SettlementBinding): Buffer {
  return createHash('sha256').update(DOMAIN).update(binding.programId.toBuffer())
    .update(binding.config.toBuffer()).update(binding.market.toBuffer()).update(Uint8Array.of(Number(binding.outcomeYes))).digest();
}
export function validateSettlementPolicy(policy: SettlementPolicy): void {
  if (!Number.isInteger(policy.threshold) || policy.threshold < 2 || policy.threshold > policy.signers.length || policy.signers.length > 5
    || new Set(policy.signers.map(s => s.toBase58())).size !== policy.signers.length || policy.signers.some(s => s.equals(PublicKey.default))) {
    throw new Error('Settlement policy needs 2..5 distinct nonzero signers and threshold >= 2');
  }
}
export function signSettlement(binding: SettlementBinding, signer: Keypair): SettlementAttestation {
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(signer.secretKey.subarray(0, 32))]), format: 'der', type: 'pkcs8' });
  return { programId: binding.programId.toBase58(), config: binding.config.toBase58(), market: binding.market.toBase58(), outcomeYes: binding.outcomeYes,
    signer: signer.publicKey.toBase58(), signature: sign(null, settlementMessage(binding), privateKey).toString('hex') };
}
export function verifySettlementAttestation(value: unknown, binding: SettlementBinding, policy: SettlementPolicy): SettlementAttestation {
  if (!value || typeof value !== 'object') throw new Error('Invalid settlement attestation');
  const a = value as Record<string, unknown>;
  if (a.programId !== binding.programId.toBase58() || a.config !== binding.config.toBase58() || a.market !== binding.market.toBase58() || a.outcomeYes !== binding.outcomeYes
    || typeof a.signer !== 'string' || typeof a.signature !== 'string' || !/^[a-f0-9]{128}$/i.test(a.signature)) throw new Error('Settlement attestation binding mismatch');
  const signer = new PublicKey(a.signer);
  if (!policy.signers.some(key => key.equals(signer))) throw new Error('Unauthorized settlement signer');
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), signer.toBuffer()]), format: 'der', type: 'spki' });
  if (!verify(null, settlementMessage(binding), publicKey, Buffer.from(a.signature, 'hex'))) throw new Error('Invalid settlement signature');
  return a as SettlementAttestation;
}
export function settlementInstructions(attestations: readonly SettlementAttestation[], binding: SettlementBinding, policy: SettlementPolicy): TransactionInstruction[] {
  validateSettlementPolicy(policy);
  const seen = new Set<string>();
  const verified = attestations.map(value => {
    const a = verifySettlementAttestation(value, binding, policy);
    if (seen.has(a.signer)) throw new Error('Duplicate settlement signer');
    seen.add(a.signer);
    return a;
  });
  if (verified.length < policy.threshold) throw new Error(`Settlement requires ${policy.threshold} independent attestations; found ${verified.length}`);
  return verified.slice(0, policy.threshold).map(a => Ed25519Program.createInstructionWithPublicKey({
    publicKey: new PublicKey(a.signer).toBytes(), signature: Buffer.from(a.signature, 'hex'), message: settlementMessage(binding),
  }));
}
/** Files may contain one attestation or an array. Invalid/unrelated files never count toward quorum. */
export async function readSettlementAttestations(directory: string, binding: SettlementBinding, policy: SettlementPolicy): Promise<SettlementAttestation[]> {
  validateSettlementPolicy(policy);
  const seen = new Map<string, SettlementAttestation>();
  let names: string[];
  try { names = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  for (const name of names.filter(n => n.endsWith('.json')).sort()) {
    let values: unknown;
    try { values = JSON.parse(await readFile(join(directory, name), 'utf8')); } catch { continue; }
    for (const value of Array.isArray(values) ? values : [values]) {
      try { const a = verifySettlementAttestation(value, binding, policy); seen.set(a.signer, a); } catch { /* Not a valid attestation for this exact settlement. */ }
    }
  }
  return [...seen.values()];
}
