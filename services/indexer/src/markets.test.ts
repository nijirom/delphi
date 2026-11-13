import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { GeminiClient, type AgentTelemetry } from '@delphi/shared';
import { ChainIndexer } from './chain.js';
import { Markets } from './markets.js';
import { Store } from './store.js';

test('market decision follows the latest stage without carrying sizing across buyer scans', () => {
  const store = new Store(':memory:');
  try {
    const chain = new ChainIndexer(store, new PublicKey('EVqrBtTWaQiwnrhXzDgqr5TML6oDpHqHs5jjeLLg42Qc'), 'http://127.0.0.1:8899', fileURLToPath(new URL('../../../packages/shared/idl/delphi.json', import.meta.url)), '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', () => {});
    chain.symbols.set('market', 'GEMI-TEST-UP');
    const markets = new Markets(store, chain, new GeminiClient({ publicBase: 'https://api.gemini.com', privateBase: 'https://api.sandbox.gemini.com' }));
    let ts = 1000;
    const emit = (stage: AgentTelemetry['stage'], detail: Record<string, unknown>, symbol = 'GEMI-TEST-UP') => store.addTelemetry({ ts: ts++, stage, detail, ...(stage === 'scan' ? {} : { instrumentSymbol: symbol }) });
    emit('scan', {});
    emit('aggregate', { probability: 0.7 });
    emit('decide', { side: 'yes', edge: 0.1, reservedUsdc: 0.2 });
    emit('aggregate', { probability: 0.1 }, 'GEMI-OTHER-UP');
    emit('trade', { orderId: 'order', status: 'filled' });
    let decision = markets.detail('GEMI-TEST-UP')!.latestDecision!;
    assert.equal(decision.stage, 'trade');
    assert.equal(decision.detail.probability, 0.7);
    assert.equal(decision.detail.reservedUsdc, 0.2);
    emit('scan', {});
    emit('skip', { reason: 'dry_run_no_payments_or_trades' });
    decision = markets.detail('GEMI-TEST-UP')!.latestDecision!;
    assert.equal(decision.stage, 'skip');
    assert.equal(decision.detail.reason, 'dry_run_no_payments_or_trades');
    assert.equal(decision.detail.probability, undefined);
    assert.equal(decision.detail.reservedUsdc, undefined);
    emit('error', { status: 'blocked' });
    assert.equal(markets.detail('GEMI-TEST-UP')!.latestDecision!.stage, 'error');
  } finally { store.db.close(); }
});
