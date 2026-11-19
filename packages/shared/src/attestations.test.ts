import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ed25519Program, Keypair } from '@solana/web3.js';
import { readSettlementAttestations, settlementInstructions, signSettlement, type SettlementBinding } from './attestations.js';

const seed = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n));
const [a, b, c, outsider] = [seed(1), seed(2), seed(3), seed(9)];
const policy = { threshold: 2, signers: [a.publicKey, b.publicKey, c.publicKey] };
const binding: SettlementBinding = { programId: seed(4).publicKey, config: seed(5).publicKey, market: seed(6).publicKey, outcomeYes: true };

test('a quorum of distinct authorized signers becomes Ed25519 precompile instructions', () => {
  const ixs = settlementInstructions([signSettlement(binding, a), signSettlement(binding, c)], binding, policy);
  assert.equal(ixs.length, 2);
  assert.ok(ixs.every(ix => ix.programId.equals(Ed25519Program.programId)));
});

test('signatures for a different outcome, market, or program never count', () => {
  for (const other of [{ ...binding, outcomeYes: false }, { ...binding, market: seed(7).publicKey }, { ...binding, programId: seed(8).publicKey }]) {
    assert.throws(() => settlementInstructions([signSettlement(other, a), signSettlement(binding, b)], binding, policy), /binding mismatch/);
  }
});

test('outsiders, duplicates, forged signatures and sub-threshold sets are rejected', () => {
  assert.throws(() => settlementInstructions([signSettlement(binding, a), signSettlement(binding, outsider)], binding, policy), /Unauthorized/);
  assert.throws(() => settlementInstructions([signSettlement(binding, a), signSettlement(binding, a)], binding, policy), /Duplicate/);
  assert.throws(() => settlementInstructions([signSettlement(binding, a)], binding, policy), /requires 2/);
  const forged = { ...signSettlement(binding, b), signature: signSettlement(binding, a).signature };
  assert.throws(() => settlementInstructions([signSettlement(binding, a), forged], binding, policy), /Invalid settlement signature/);
});

test('attestation directory ignores junk and unrelated files and dedupes by signer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'delphi-attest-'));
  writeFileSync(join(dir, 'a.json'), JSON.stringify(signSettlement(binding, a)));
  writeFileSync(join(dir, 'a-again.json'), JSON.stringify([signSettlement(binding, a)]));
  writeFileSync(join(dir, 'flip.json'), JSON.stringify(signSettlement({ ...binding, outcomeYes: false }, b)));
  writeFileSync(join(dir, 'junk.json'), '{not json');
  const found = await readSettlementAttestations(dir, binding, policy);
  assert.deepEqual(found.map(x => x.signer), [a.publicKey.toBase58()]);
});
