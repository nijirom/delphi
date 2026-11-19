import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { openStore } from './store.js';
import { createPublishingStore } from './publishing-store.js';
import { authenticatePublication, publicationMessage, PublicationError, type PublicationPayload } from './publishing-protocol.js';

const wallet = Keypair.fromSeed(new Uint8Array(32).fill(1));
const domain = { audience: 'http://127.0.0.1:4020', programId: Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey.toBase58(), genesisHash: 'genesis' };
const now = 1_800_000_000;
function envelope(overrides: Partial<PublicationPayload> = {}, signer = wallet) {
  const payload: PublicationPayload = { version: 1, ...domain, authority: wallet.publicKey.toBase58(), forecastPda: Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58(), eventTicker: 'BTC05M2611140745', instrumentSymbol: 'GEMI-BTC05M2611140745-UP', probBps: 6500, salt: 'ab'.repeat(32), rationale: 'r', nonce: randomBytes(32).toString('hex'), issuedAt: now, expiresAt: now + 300, ...overrides };
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(signer.secretKey.subarray(0, 32))]), format: 'der', type: 'pkcs8' });
  return { payload, signature: sign(null, publicationMessage(payload), key).toString('base64') };
}
const status = (fn: () => unknown) => { try { fn(); } catch (e) { assert.ok(e instanceof PublicationError); return e.status; } return 200; };

test('a wallet-signed publication for this deployment authenticates', () => {
  assert.equal(authenticatePublication(envelope(), domain, now).probBps, 6500);
});

test('tampering with any signed field after signing is rejected', () => {
  const body = envelope();
  body.payload.probBps = 9900;
  assert.equal(status(() => authenticatePublication(body, domain, now)), 401);
});

test('another wallet cannot publish under an authority it does not control', () => {
  assert.equal(status(() => authenticatePublication(envelope({}, Keypair.generate()), domain, now)), 401);
});

test('signatures bound to another server, program, or chain do not transfer', () => {
  for (const other of [{ audience: 'https://evil.example' }, { programId: wallet.publicKey.toBase58() }, { genesisHash: 'other' }]) {
    assert.equal(status(() => authenticatePublication(envelope(other), domain, now)), 400);
  }
});

test('expired, future-dated and extra-field envelopes are rejected', () => {
  assert.equal(status(() => authenticatePublication(envelope(), domain, now + 301)), 401);
  assert.equal(status(() => authenticatePublication(envelope({ issuedAt: now + 60, expiresAt: now + 120 }), domain, now)), 401);
  assert.equal(status(() => authenticatePublication({ ...envelope(), extra: 1 }, domain, now)), 400);
});

test('a replayed nonce and a second publication for the same forecast are refused', () => {
  const store = createPublishingStore(openStore(':memory:'));
  const { payload } = envelope();
  const row = (pda: string) => ({ authority: payload.authority, reveal: { forecast_pda: pda, persona: `external:${payload.authority}`, event_ticker: payload.eventTicker, instrument_symbol: payload.instrumentSymbol, prob_bps: 6500, salt_hex: payload.salt, rationale: '', posted_at: now, tx: null } });
  store.publish(row(payload.forecastPda), payload.nonce, payload.expiresAt, now);
  assert.equal(status(() => store.publish(row('other'), payload.nonce, payload.expiresAt, now)), 409);
  assert.equal(status(() => store.publish(row(payload.forecastPda), 'cd'.repeat(32), payload.expiresAt, now)), 409);
  assert.equal(store.list().length, 1);
});
