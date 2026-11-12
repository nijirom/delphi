import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, safeUrl, units, orderPlan } from './guardrails.js';
import type { GeminiContract } from '@delphi/shared';

test('reservations survive reopen, duplicate and uncertain attempts cannot spend again',()=>{
  const dir=mkdtempSync(join(tmpdir(),'delphi-buyer-'));const path=join(dir,'ledger.sqlite');
  try {
    let db=new Ledger(path,1000000,600000,500000);
    assert.equal(db.reserve('read','f1','symbol',100000),true);
    assert.equal(db.reserve('read','f1','symbol',100000),false);
    assert.equal(db.reserve('trade','symbol','symbol',500000),true);
    assert.equal(db.reserve('read','f2','symbol',1),false);
    db.close();db=new Ledger(path,1000000,600000,500000);
    assert.equal(db.reserve('trade','symbol','symbol',1),false);
    assert.equal(db.reserve('read','f3','other',400001),false);
    assert.equal(db.reserve('read','f3','other',400000),true);db.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('destination and amount validation fail closed',()=>{
  assert.throws(()=>safeUrl('https://evil.example/f','http://localhost:4020'));
  assert.throws(()=>safeUrl('http://user:pass@localhost:4020/f','http://localhost:4020'));
  assert.equal(safeUrl('/forecasts/abc','http://localhost:4020'),'http://localhost:4020/forecasts/abc');
  assert.equal(units('0.01'),10000);assert.throws(()=>units('0.0000001'));assert.throws(()=>units(-1));
});
test('order uses executable ask, rounded quantity and fee-inclusive reserve',()=>{
  const contract:GeminiContract={id:'id',label:'label',ticker:'ticker',instrumentSymbol:'symbol',status:'active',resolutionSide:null,resolvedAt:null,expiryDate:null,prices:{buy:{yes:'0.61',no:'0.42'},sell:{yes:'0.58',no:'0.39'},bestBid:'0.58',bestAsk:'0.601',lastTradePrice:'0.59'},quantityMinimum:'1',quantityIncrement:'0.1',priceIncrement:'0.01',priceMinimum:'0.01'};
  const plan=orderPlan(contract,0.8,2,200);assert.ok(plan);assert.equal(plan.price,'0.61');assert.equal(plan.side,'yes');assert.ok(plan.reserve<=2000000);assert.ok(plan.edge<0.19);
  assert.equal(orderPlan({...contract,quantityIncrement:undefined},0.8,2,200),null);
  assert.equal(orderPlan(contract,0.6,2,200),null);
});
