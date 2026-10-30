import assert from 'node:assert/strict';
import test from 'node:test';
import {createPostgresSemanticAdmission} from '../scripts/lib/postgres-semantic-admission.mjs';
const budget={maxTriggerCalls:3,maxTriggerTokens:120,maxTriggerCostMicros:1000,
  maxBatchCalls:2,maxBatchTokens:80,maxBatchCostMicros:800};
const req={namespace:'tenant:trigger@1',nodeId:'semantic',
  candidateSignature:'opaque-id',evaluatorIdentity:'model/mock-v1',
  inputBytes:18,instructionBytes:24};
function noStoreWork(){
  let transactions=0;
  return {scopeId:'tenant',
    lock(){throw Error('unexpected ledger access')},
    get(){throw Error('unexpected ledger access')},
    upsert(){throw Error('unexpected ledger access')},
    tx(){transactions++;throw Error('unexpected transaction')},
    get transactions(){return transactions},
  };
}
test('hung cost estimator is denied before any durable reservation',async()=>{
  const store=noStoreWork();
  let calls=0;
  const gate=createPostgresSemanticAdmission({store,budget,batchId:'one',
    maxEstimateMs:25,
    estimate:()=>{calls++;return new Promise(()=>{});},
  });
  assert.equal(await gate.reserve(req),false);
  assert.equal(calls,1);
  assert.equal(store.transactions,0);
});
test('late estimator response cannot retroactively authorize quota',async()=>{
  const store=noStoreWork();
  let settle;
  const gate=createPostgresSemanticAdmission({store,budget,batchId:'one',
    maxEstimateMs:25,
    estimate:()=>new Promise(resolve=>{settle=resolve;}),
  });
  assert.equal(await gate.reserve(req),false);
  settle({tokens:1,costMicros:1});
  await Promise.resolve();
  assert.equal(store.transactions,0);
});
test('invalid pre-admission estimator deadlines are rejected',()=>{
  for(const n of [0,9,30001,NaN,1.5,'100',null]){
    assert.throws(()=>createPostgresSemanticAdmission({
      store:noStoreWork(),budget,batchId:'one',
      estimate:()=>({tokens:1,costMicros:1}),maxEstimateMs:n,
    }),/maxEstimateMs/);
  }
});
