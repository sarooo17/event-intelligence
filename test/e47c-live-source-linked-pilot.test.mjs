import test from 'node:test';
import assert from 'node:assert/strict';
import {pilotConfig,nearestRank} from '../scripts/validation/live-e47c-source-linked-pilot-once.mjs';

const good={
 EI_E47C_ARTIFACT_DIR:'/evidence/e47c',
 EI_E47C_SOURCE_SHA:'a'.repeat(40),
 EI_LIVE_SOURCE_URL:'http://e47c-source.railway.internal:3000',
 EI_LIVE_SOURCE_TOKEN:'source-only-secret-should-not-appear-in-report',
 EI_LIVE_WORKER_A_URL:'http://ei-a.railway.internal:3000',
 EI_LIVE_WORKER_B_URL:'http://ei-b.railway.internal:3000',
 EI_LIVE_WORKER_TOKEN:'worker-token-not-to-print',
 EI_LIVE_BASE_SCOPE:'ei-validation',
 DATABASE_URL:'postgresql://fake-user:fake-pass@localhost/fake',
 EI_TABLE_PREFIX:'ei_validation',
 EI_SOURCE_SERVER_ID:'bound-source',
 EI_SOURCE_EVENT_NAME:'fixture.changed',
 EI_SOURCE_TRUSTED_PUBLIC_KEY_PEM:'-----BEGIN PUBLIC KEY-----\\nredacted\\n-----END PUBLIC KEY-----',
 EI_SOURCE_TRUSTED_PUBLIC_KEY_SHA256:'b'.repeat(64),
 EI_SOURCE_SCOPE_ID:'scope',EI_SOURCE_KEY_DIGEST:'c'.repeat(64),
 EI_SOURCE_CONNECTION_ID:'conn',EI_SOURCE_ARGUMENTS_CANONICAL:'{}'
};
test('pilot defaults are explicitly small and no stage is represented as production',()=>{
 const c=pilotConfig(good);
 assert.equal(c.count,10);
 assert.equal(c.triggers,10);
 assert.equal(c.delayMs,100);
 assert.equal(c.sourceSha,'a'.repeat(40));
 assert.match(c.signer,/BEGIN PUBLIC KEY/);
});
test('high-cardinality and rate widening require explicit bounded config',()=>{
 assert.throws(()=>pilotConfig({...good,EI_E47C_PILOT_EVENTS:'26'}),/E47C_PILOT_LIMIT_EXCEEDED/);
 assert.throws(()=>pilotConfig({...good,EI_E47C_PILOT_TRIGGERS:'100000'}),/E47C_PILOT_LIMIT_EXCEEDED/);
 assert.throws(()=>pilotConfig({...good,EI_E47C_PILOT_TRIGGERS:'2'}),/E47C_PILOT_LIMIT_EXCEEDED/);
 assert.throws(()=>pilotConfig({...good,EI_E47C_PILOT_EVENT_DELAY_MS:'-1'}),/E47C_PILOT_LIMIT_EXCEEDED/);
 assert.equal(pilotConfig({...good,EI_E47C_PILOT_EVENTS:'25',EI_E47C_PILOT_TRIGGERS:'1000'}).triggers,1000);
});
test('never allow public source URL, ephemeral artifact path or unpinned source',()=>{
 assert.throws(()=>pilotConfig({...good,EI_LIVE_SOURCE_URL:'https://example.com'}),/private HTTP networking/);
 assert.throws(()=>pilotConfig({...good,EI_E47C_ARTIFACT_DIR:'/tmp/output'}),/E47C_REQUIRE_PRIVATE_DURABLE_ARTIFACT_DIR/);
 assert.throws(()=>pilotConfig({...good,EI_E47C_ARTIFACT_DIR:'./artifacts'}),/E47C_REQUIRE_PRIVATE_DURABLE_ARTIFACT_DIR/);
 assert.throws(()=>pilotConfig({...good,EI_E47C_SOURCE_SHA:'main'}),/E47C_SOURCE_SHA_REQUIRED/);
});
test('nearest-rank quantiles recompute samples rather than trusting reported percentiles',()=>{
 assert.equal(nearestRank([9,1,2,4,8],.5),4);
 assert.equal(nearestRank([9,1,2,4,8],.95),9);
 assert.throws(()=>nearestRank([1,-2],.99),/E47C_INVALID_LATENCY/);
 assert.throws(()=>nearestRank([],.99),/E47C_INVALID_LATENCY/);
});
test('incomplete required private source contract rejects before any network access',()=>{
 for(const key of ['EI_LIVE_SOURCE_TOKEN','EI_LIVE_WORKER_TOKEN','EI_TABLE_PREFIX','EI_SOURCE_KEY_DIGEST']){
  const env={...good};delete env[key];
  assert.throws(()=>pilotConfig(env),new RegExp('E47C_MISSING_'+key));
 }
});
