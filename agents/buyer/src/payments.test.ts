import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { GeminiClient, commitment, marketHash, pdas, type AgentTelemetry, type DelphiProgram, type Env, type ForecastListing } from '@delphi/shared';
import { Ledger } from './guardrails.js';
import { Buyer } from './loop.js';
import { verifyListing } from './x402.js';

const SETTLEMENT = Buffer.from(JSON.stringify({ success: true, transaction: bs58.encode(new Uint8Array(64).fill(7)) })).toString('base64');

/** A buyer with no cached read, so the paid-read path actually runs. `reveal` is what the forecast URL answers. */
function scenario(t: TestContext, reveal: (salt: string, probBps: number, request: Request) => Response) {
  const dir = mkdtempSync(join(tmpdir(), 'delphi-payments-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const symbol = 'GEMI-CONTRACT-UP', ticker = 'PARENT-EVENT', probBps = 9000, salt = Buffer.alloc(32, 4);
  const wallet = Keypair.fromSeed(new Uint8Array(32).fill(1)), authority = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey;
  const programId = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey, addresses = pdas(programId);
  const forecaster = addresses.forecaster(authority), forecast = addresses.forecast(forecaster, marketHash(symbol));
  const listing: ForecastListing = { forecastPda: forecast.toBase58(), forecasterPda: forecaster.toBase58(), forecasterAuthority: authority.toBase58(), forecasterName: 'Fixture', instrumentSymbol: symbol, pricePerReadUsdc: 0.01, reputationBps: 9000, scoredCount: 10, postedAt: Date.now(), url: `http://localhost:4020/forecasts/${forecast.toBase58()}` };
  const market = { resolved: false, outcomeYes: false };
  const chain = { forecaster, market: addresses.market(marketHash(symbol)), commitment: commitment(probBps, salt), pricePerRead: 10000n, revealed: false, forfeited: false };
  const calls = { recordPurchase: 0, revealAndScore: 0 };
  let recordFails = false;
  const program = {
    fetchForecast: async () => chain,
    fetchForecaster: async () => ({ authority, pricePerRead: 10000n, reputationBps: 9000 }),
    fetchMarket: async () => market,
    hasPurchase: async () => false,
    recordPurchase: async () => { calls.recordPurchase++; if (recordFails) throw new Error('Market already resolved'); return 'recorded'; },
    revealAndScore: async () => { calls.revealAndScore++; chain.revealed = true; return 'revealed'; },
  } as unknown as DelphiProgram;
  const contract = { id: 'c', label: 'Up', ticker: 'UP', instrumentSymbol: symbol, status: 'active', resolutionSide: null, resolvedAt: null, expiryDate: new Date(Date.now() + 3600000).toISOString(), prices: { buy: { yes: '0.8', no: '0.3' }, sell: { yes: '0.7', no: '0.2' }, bestBid: '0.7', bestAsk: '0.8', lastTradePrice: '0.75' }, quantityMinimum: '1', quantityIncrement: '1', priceIncrement: '0.01', priceMinimum: '0.01' };
  const event = { id: 'e', title: 'Event', ticker, category: 'crypto', type: 'binary', status: 'active', resolvedAt: null, expiryDate: contract.expiryDate, contracts: [contract] };
  const mint = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
  const mintData = Buffer.alloc(82); mintData.writeUInt8(6, 44); mintData.writeUInt8(1, 45);
  const tokenData = Buffer.alloc(165); mint.toBuffer().copy(tokenData, 0); wallet.publicKey.toBuffer().copy(tokenData, 32);
  tokenData.writeBigUInt64LE(1_000_000n, 64); tokenData.writeUInt8(1, 108);
  const payerToken = getAssociatedTokenAddressSync(mint, wallet.publicKey).toBase58();
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === 'http://localhost:4020' && url.pathname === '/forecasts') return Response.json([listing]);
    if (url.href === listing.url) return reveal(salt.toString('hex'), probBps, input instanceof Request ? input : new Request(input, init));
    if (url.origin === 'http://localhost:4999') return Response.json({ data: [event], pagination: { limit: 100, offset: 0, total: 1 } });
    // Solana RPC: the purchase account does not exist, so reconcile attempts to record it.
    if (url.origin === 'http://localhost:8899') {
      const rpc = JSON.parse(String(init?.body)) as { id: unknown; method: string; params?: unknown[] };
      if (rpc.method === 'getAccountInfo') {
        const address = typeof rpc.params?.[0] === 'string' ? rpc.params[0] : '';
        const data = address === mint.toBase58() ? mintData : address === payerToken ? tokenData : null;
        return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { context: { slot: 1 }, value: data ? { data: [data.toString('base64'), 'base64'], executable: false, lamports: 1, owner: TOKEN_PROGRAM_ID.toBase58(), rentEpoch: 0, space: data.length } : null } });
      }
      if (rpc.method === 'getLatestBlockhash') return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { context: { slot: 1 }, value: { blockhash: bs58.encode(new Uint8Array(32).fill(9)), lastValidBlockHeight: 1000 } } });
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result: null });
    }
    throw new Error(`Unexpected network request: ${url.href}`);
  });
  const env = { BUYER_DRY_RUN: false, FORECASTER_URL: 'http://localhost:4020', SOLANA_RPC_URL: 'http://localhost:8899', BUYER_MIN_FORECASTER_REPUTATION_BPS: 5000, BUYER_MAX_READ_PRICE_USDC: 1, BUYER_MAX_POSITION_USDC: 5, BUYER_PER_MARKET_BUDGET_USDC: 10, BUYER_EDGE_THRESHOLD: 0.15, GEMINI_API_BASE: 'https://api.sandbox.gemini.com', BUYER_VOICE_APPROVE_ABOVE_USDC: 100, BUYER_AUTO_APPROVE_BELOW_USDC: 100 } as Env;
  const ledger = new Ledger(join(dir, 'ledger.sqlite'), 100000000, 10000000, 5000000);
  t.after(() => ledger.close());
  const gemini = new GeminiClient({ publicBase: 'http://localhost:4999', privateBase: env.GEMINI_API_BASE });
  const buyer = new Buyer({ env, ledger, gemini, program, wallet, programId, allowLive: false, feeBps: 0 });
  const telemetry: { stage: AgentTelemetry['stage']; detail: Record<string, unknown> }[] = [];
  t.mock.method(buyer, 'emit', async (stage: AgentTelemetry['stage'], detail: Record<string, unknown>) => { telemetry.push({ stage, detail }); });
  return { buyer, ledger, telemetry, calls, pda: listing.forecastPda, symbol, listing, market, chain, failRecording: () => { recordFails = true; } };
}

const payload = (salt: string, probBps: number, pda: string, symbol: string) => ({ forecastPda: pda, instrumentSymbol: symbol, probBps, salt, rationale: 'Fixture', forecasterName: 'Fixture' });

test('a pre-signing HTTP failure releases the provably unspent reservation', async t => {
  const s = scenario(t, () => Response.json({ error: 'Forecast no longer available' }, { status: 409 }));
  await s.buyer.tick();
  assert.equal(s.ledger.has('read', s.pda), false, 'an unsigned attempt must not hold the per-market budget');
  assert.deepEqual(s.ledger.reads(), []);
  assert.ok(s.telemetry.some(e => e.stage === 'error' && e.detail.status === 'unpaid_reservation_released'));
  // A later poll can retry the same forecast instead of being locked out by the failed one.
  assert.equal(s.ledger.reserve('read', s.pda, s.symbol, 10000), true);
});

test('a post-transmission error without a settlement receipt retains the reservation', async t => {
  const feePayer = Keypair.fromSeed(new Uint8Array(32).fill(8)).publicKey.toBase58();
  const s = scenario(t, (_salt, _probBps, request) => {
    if (request.headers.has('PAYMENT-SIGNATURE')) return Response.json({ error: 'malicious denial' }, { status: 500 });
    const required = {
      x402Version: 2,
      error: 'Payment required',
      resource: { url: s.listing.url, description: 'Forecast', mimeType: 'application/json' },
      accepts: [{ scheme: 'exact', network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', amount: '10000', payTo: s.listing.forecasterAuthority, maxTimeoutSeconds: 120, extra: { feePayer, transactionVersions: [0] } }],
    };
    return Response.json(required, { status: 402, headers: { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(required)).toString('base64') } });
  });
  await s.buyer.tick();
  assert.equal(s.ledger.has('read', s.pda), true, 'an ambiguous paid attempt must keep its budget quarantined');
  assert.deepEqual(s.ledger.reads(), []);
  assert.ok(s.telemetry.some(e => e.stage === 'error' && e.detail.status === 'blocked_or_reservation_retained'));
});

test('a settled read is stored, pooled, and reconciled into a purchase and a reveal', async t => {
  const s = scenario(t, (salt, probBps) => Response.json(payload(salt, probBps, s.pda, s.symbol), { headers: { 'PAYMENT-RESPONSE': SETTLEMENT } }));
  await s.buyer.tick();
  assert.equal(s.ledger.reads().length, 1);
  assert.ok(s.telemetry.some(e => e.stage === 'aggregate' && Math.abs(Number(e.detail.probability) - 0.9) < 1e-12));
  await s.buyer.reconcile();
  assert.equal(s.calls.recordPurchase, 1);
  assert.equal(s.calls.revealAndScore, 0);
  s.market.resolved = true;
  await s.buyer.reconcile();
  assert.equal(s.calls.revealAndScore, 1);
  await s.buyer.reconcile();
  assert.equal(s.calls.revealAndScore, 1, 'a completed reveal is terminal');
});

test('a reveal still lands when the market resolved before the purchase was recorded', async t => {
  const s = scenario(t, (salt, probBps) => Response.json(payload(salt, probBps, s.pda, s.symbol), { headers: { 'PAYMENT-RESPONSE': SETTLEMENT } }));
  await s.buyer.tick();
  s.market.resolved = true;
  await s.buyer.reconcile();
  assert.equal(s.calls.recordPurchase, 0, 'record_purchase is rejected on-chain after resolution, so it is skipped');
  assert.equal(s.calls.revealAndScore, 1, 'the paid forecast is still revealed and scored');
  await s.buyer.reconcile();
  assert.equal(s.calls.recordPurchase, 0, 'the row is marked terminal so later ticks do not retry');
});
test('a payload that can never validate is quarantined instead of retried every tick', async t => {
  const s = scenario(t, (_salt, probBps) => Response.json(payload('0'.repeat(64), probBps, s.pda, s.symbol), { headers: { 'PAYMENT-RESPONSE': SETTLEMENT } }));
  await s.buyer.tick();
  assert.equal(s.ledger.reads().length, 1, 'the paid body is retained for inspection');
  s.market.resolved = true;
  await s.buyer.reconcile();
  assert.ok(s.telemetry.some(e => e.detail.status === 'payload_quarantined'));
  assert.deepEqual(s.ledger.reads(), []);
  assert.equal(s.calls.revealAndScore, 0);
  assert.equal(s.ledger.has('read', s.pda), true, 'the payment still happened, so the budget stays spent');
});

test('listing verification trusts chain reputation, not the listing, but never a different price', async () => {
  const authority = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey, programId = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey;
  const addresses = pdas(programId), symbol = 'GEMI-CONTRACT-UP';
  const forecaster = addresses.forecaster(authority), forecast = addresses.forecast(forecaster, marketHash(symbol));
  let chainReputation = 7200, chainPrice = 10000n;
  const program = {
    fetchForecast: async () => ({ forecaster, pricePerRead: chainPrice, revealed: false, forfeited: false, commitment: new Uint8Array(32) }),
    fetchForecaster: async () => ({ authority, pricePerRead: chainPrice, reputationBps: chainReputation, scoredCount: 40 }),
    fetchMarket: async () => ({ resolved: false }),
  } as unknown as DelphiProgram;
  // The listing was refreshed before the latest resolution moved reputation on chain.
  const stale: ForecastListing = { forecastPda: forecast.toBase58(), forecasterPda: forecaster.toBase58(), forecasterAuthority: authority.toBase58(), forecasterName: 'quant', instrumentSymbol: symbol, pricePerReadUsdc: 0.01, reputationBps: 7600, scoredCount: 39, postedAt: 0, url: `http://localhost:4020/forecasts/quant/${forecast.toBase58()}` };
  const v = await verifyListing(program, stale, 'http://localhost:4020', 4000);
  assert.equal(v.listing.reputationBps, 7200, 'weights use the on-chain reputation');
  chainReputation = 3900;
  await assert.rejects(verifyListing(program, stale, 'http://localhost:4020', 4000), /below minimum/);
  chainReputation = 7200; chainPrice = 20000n;
  await assert.rejects(verifyListing(program, stale, 'http://localhost:4020', 4000), /price mismatch/);
});
