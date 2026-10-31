import test from 'node:test';
import assert from 'node:assert/strict';
import {assessDeployedHostPreflight} from
  '../scripts/validation/deployed-host-security-preflight.mjs';
const sha='a'.repeat(40),digest='b'.repeat(64);
const probes=['postWakeReauthorization','revocationWhileQueued',
  'durableEffectReceipt','tenantQuota','compressedBodyLimit',
  'requestTimeout','policyCancellation'];
const worker=name=>({
  serviceName:name,
  variableNames:['EVENT_INTELLIGENCE_REQUIRE_SHARED_STORE','DATABASE_URL'],
  runtimeEvidence:{sourceCommit:sha,requireMcpSessionFence:true,
    strictSharedStoreEnabled:true,mixedLegacyWritersAbsent:true,
    connectionEpochWitnesses:[{sourceId:'producer-one',hostOwned:true,
      epochCommitmentSha256:digest}]},
});
const fixture=()=>({
  sourceCommit:sha,project:'ei-security-staging',environment:'staging',
  workers:[worker('worker-a'),worker('worker-b')],
  postgres:{primaryTopology:'ha-failover-tested'},
  host:{separatelyOperated:true,maintainerDifferentFromEi:true,
    probes:Object.fromEntries(probes.map(p=>[p,{passed:true,
      sourceCommit:sha,redactedArtifactSha256:digest}]))},
  independentReview:{completed:true,coversTwelveBoundaries:true,
    sourceCommit:sha,redactedReportDigest:digest}
});
const codes=x=>x.failures.map(y=>y.code);
test('multiworker deployment readiness never self-certifies even with full self-supplied report',()=>{
  const r=assessDeployedHostPreflight(fixture());
  assert.equal(r.status,'operator-evidence-ready-for-independent-verification');
  assert.equal(r.deploymentCertified,false);
  assert.equal(r.externalSecuritySignedOff,false);
  assert.equal(r.inventoryOnly,true);
  assert.equal(r.irreversibleChangesPerformed,false);
  assert.deepEqual(r.failures,[]);
});
test('realistic Railway staging inventory with no strict flags is blocked, not asserted secure',()=>{
  const v=fixture();
  for(const w of v.workers){w.variableNames=['DATABASE_URL','EI_SCOPE_ID','EI_TABLE_PREFIX'];
    w.runtimeEvidence=undefined;}
  v.postgres.primaryTopology='single-instance';
  v.host.separatelyOperated=false;
  v.host.maintainerDifferentFromEi=false;
  v.host.probes={};
  v.independentReview=undefined;
  const r=assessDeployedHostPreflight(v);
  assert.equal(r.status,'blocked');
  for(const code of ['STRICT_SHARED_STORE_ENV_MISSING','RUNTIME_FENCE_NOT_ATTESTED',
    'LEGACY_WRITER_EXCLUSION_UNVERIFIED','HOST_EPOCH_WITNESS_MISSING',
    'PG_PRIMARY_HA_NOT_MEASURED','INDEPENDENT_HOST_UNPROVEN',
    'HOST_PROBE_UNVERIFIED','INDEPENDENT_HUMAN_REVIEW_PENDING']){
    assert.ok(codes(r).includes(code),code);
  }
  assert.equal(r.deploymentCertified,false);
  // Must not echo host secrets, env values, private scopes or bearer headers.
  assert.equal(JSON.stringify(r).includes('DATABASE_URL'),false);
});
test('mixed fenced/unfenced writers and stale authority epochs fail closed',()=>{
  const v=fixture();
  v.workers[1].runtimeEvidence.requireMcpSessionFence=false;
  v.workers[1].runtimeEvidence.mixedLegacyWritersAbsent=false;
  v.workers[1].runtimeEvidence.connectionEpochWitnesses[0].hostOwned=false;
  const r=assessDeployedHostPreflight(v);
  assert.ok(codes(r).includes('RUNTIME_FENCE_NOT_ATTESTED'));
  assert.ok(codes(r).includes('LEGACY_WRITER_EXCLUSION_UNVERIFIED'));
  assert.ok(codes(r).includes('HOST_EPOCH_WITNESS_MISSING'));
});
test('host receipt-only success never replaces revocation, quota or cancellation witness',()=>{
  const v=fixture();delete v.host.probes.revocationWhileQueued;
  delete v.host.probes.compressedBodyLimit;delete v.host.probes.policyCancellation;
  const r=assessDeployedHostPreflight(v);
  assert.equal(codes(r).filter(x=>x==='HOST_PROBE_UNVERIFIED').length,3);
  assert.equal(r.deploymentCertified,false);
});
test('require duplicate instance rejection, valid declared SHA and bounded inventory',()=>{
  for(const change of [
    x=>{x.workers[1].serviceName=x.workers[0].serviceName;},
    x=>{x.sourceCommit='main';},
    x=>{x.workers.push(worker('extra'));x.workers[2].variableNames.push('DATABASE_URL');},
    x=>{x.workers.length=1;}
  ]){
    const v=fixture();change(v);const r=assessDeployedHostPreflight(v);
    assert.equal(r.status,'blocked');
    assert.equal(r.deploymentCertified,false);
  }
});
