import test from 'node:test';
import assert from 'node:assert/strict';
import {progressiveConfig} from '../scripts/validation/e47c-progressive-1k-stage-once.mjs';

const env={
 EI_E47C_STAGE_CONFIRM:'RUN_1000_FIRST_PARTY_STAGING',
 EI_E47C_STAGE_RATE:'1',
 EI_E47C_STAGE_EVENTS:'50',
 EI_E47C_ARTIFACT_DIR:'/evidence',
 EI_E47C_SOURCE_SHA:'a'.repeat(40),
 EI_LIVE_SOURCE_URL:'http://source.railway.internal:3000',
 EI_LIVE_SOURCE_TOKEN:'private-source-token',
 EI_LIVE_WORKER_A_URL:'http://ei-a.railway.internal:3000',
 EI_LIVE_WORKER_B_URL:'http://ei-b.railway.internal:3000',
 EI_LIVE_WORKER_TOKEN:'private-ingest-token',
 EI_LIVE_BASE_SCOPE:'e47c-validation',
 DATABASE_URL:'postgresql://fake-user:fake-pass@localhost/ei',
 EI_TABLE_PREFIX:'ei_validation',
 EI_SOURCE_SERVER_ID:'source-server',
 EI_SOURCE_EVENT_NAME:'test.changed',
 EI_SOURCE_TRUSTED_PUBLIC_KEY_PEM:'-----BEGIN PUBLIC KEY-----\\nredacted\\n-----END PUBLIC KEY-----',
 EI_SOURCE_TRUSTED_PUBLIC_KEY_SHA256:'b'.repeat(64),
 EI_SOURCE_SCOPE_ID:'source-scope',
 EI_SOURCE_KEY_DIGEST:'c'.repeat(64),
 EI_SOURCE_CONNECTION_ID:'connection',
 EI_SOURCE_ARGUMENTS_CANONICAL:'{}',
};
test('1k stage requires explicit operator opt-in and exact one of two offered rates',()=>{
 assert.throws(()=>progressiveConfig({...env,EI_E47C_STAGE_CONFIRM:undefined}),
  /E47C_STAGE_EXPLICIT_OPT_IN_REQUIRED/);
 for(const rate of ['0','2','100','abc']){
  assert.throws(()=>progressiveConfig({...env,EI_E47C_STAGE_RATE:rate}),
   /E47C_UNSUPPORTED_STAGE_RATE/);
 }
 for(const rate of ['1','5']){
  const c=progressiveConfig({...env,EI_E47C_STAGE_RATE:rate});
  assert.equal(c.triggers,1000);
  assert.equal(c.rate,Number(rate));
  assert.equal(c.delayMs,1000/Number(rate));
  assert.equal(c.workerInflight,4);
  assert.equal(c.count,50);
 }
});
test('stage bounds prevent accidental 10k/100k load and unlimited source appends',()=>{
 for(const count of ['0','9','251','1000','abc']){
  assert.throws(()=>progressiveConfig({...env,EI_E47C_STAGE_EVENTS:count}),
   /E47C_PILOT_LIMIT_EXCEEDED/);
 }
 assert.equal(progressiveConfig({...env,EI_E47C_STAGE_EVENTS:'250'}).count,250);
});
test('worker ingress concurrency limit refuses zero, negative and unbounded values',()=>{
 for(const n of ['0','-1','9','100','abc']){
  assert.throws(()=>progressiveConfig({...env,EI_E47C_WORKER_MAX_INFLIGHT:n}),
   /E47C_PILOT_LIMIT_EXCEEDED/);
 }
 for(const n of ['1','2','4','8']){
  assert.equal(progressiveConfig({...env,EI_E47C_WORKER_MAX_INFLIGHT:n}).workerInflight,Number(n));
 }
});
test('stage refuses public URLs, unpinned sources and ephemeral archives',()=>{
 assert.throws(()=>progressiveConfig({...env,EI_LIVE_SOURCE_URL:'https://example.com'}));
 assert.throws(()=>progressiveConfig({...env,EI_E47C_SOURCE_SHA:'main'}),/E47C_SOURCE_SHA_REQUIRED/);
 assert.throws(()=>progressiveConfig({...env,EI_E47C_ARTIFACT_DIR:'./tmp'}));
});
