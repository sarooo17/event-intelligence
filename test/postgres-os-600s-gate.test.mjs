import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {
  MIN_ACTIVE_MS,verifyPostgresLongOsChaosEvidence,
} from '../scripts/evidence/postgres-os-600s-gate.mjs';

const SHA='a'.repeat(40);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function fake(){
  const batches=[],rawFiles=[];
  for(let i=0;i<2;i++){
    const cohorts=[];
    for(let j=0;j<2;j++){
      const evidence=[];
      for(let k=0;k<2;k++){
        const unique=i*10+j*3+k+1;
        const wakeId='wake-'+unique;
        evidence.push({round:k,signal:'SIGKILL',killedPid:unique*10,
          successorPids:[unique*10+1,unique*10+2],
          attempts:1,effects:1,deliveryGeneration:1,
          matchId:'match-'+unique,wakeId,
          receiptId:'fixture-external:'+wakeId});
      }
      cohorts.push({cohort:j+1,rounds:2,wallMs:160000,
        observedHostEffects:2,observedHostAttempts:2,
        duplicateHostAttempts:0,evidence});
    }
    const raw={
      schema:'ei-postgres-os-chaos-soak-v1',status:'completed',
      productionSloCertified:false,sourceCommitSha:SHA,
      postgres:{serverVersion:'16.15',serverVersionNum:160015},
      workload:{physicalOsProcesses:true,postgresSharedState:true,
        independentWorkerPool:true,cohorts:2,roundsPerCohort:2,
        totalKillRecoveryRounds:4},
      metrics:{committedUniqueMatches:4,deliveredReceipts:4,
        hostAttempts:4,hostEffects:4,duplicateHostAttempts:0,
        totalWallMs:325000},
      cohorts,
    };
    const bytes=Buffer.from(JSON.stringify(raw));
    rawFiles.push(bytes);
    batches.push({batch:i+1,
      rawFile:'batch-'+String(i+1).padStart(4,'0')+'.json',
      sha256:digest(bytes),activeMs:320000,crashRecoveryRounds:4});
  }
  return {manifest:{
    schema:'ei-postgres-os-600s-continuous-v1',
    status:'completed',sourceCommitSha:SHA,
    productionSloCertified:false,externalProviderMeasured:false,
    externalHostMeasured:false,
    postgres:{serverVersion:'16.15',serverVersionNum:160015},
    hardware:{node:'v22.14.0'},
    workload:{physicalOsProcesses:true,sharedPostgres16:true,
      continuousNoSyntheticDelay:true,cohortsPerBatch:2,roundsPerCohort:2,
      batchCount:2,minActiveMs:MIN_ACTIVE_MS},
    metrics:{actualActiveMs:640000,actualCrashRecoveryRounds:8,
      verifiedReceipts:8,hostEffects:8,unaccountedDuplicateEffects:0,
      observedWallMs:650000},
    batches,
  },rawFiles};
}
const checked=x=>verifyPostgresLongOsChaosEvidence(
  x.manifest,x.rawFiles,{expectedSourceSha:SHA});

test('gate recomputes all raw SIGKILL and durable receipt evidence',()=>{
  const x=fake(),result=checked(x);
  assert.equal(result.ok,true);
  assert.equal(result.activeMs,640000);
  assert.equal(result.rounds,8);
  assert.equal(result.productionSloCertified,false);
});

test('gate rejects missing or tampered raw results, fake duration, wrong SHA',()=>{
  const checks=[
    x=>x.rawFiles.pop(),
    x=>x.rawFiles[0][5]^=1,
    x=>x.manifest.metrics.actualActiveMs=MIN_ACTIVE_MS-1,
    x=>x.manifest.metrics.observedWallMs=1,
    x=>x.manifest.productionSloCertified=true,
    x=>x.manifest.externalProviderMeasured=true,
    x=>x.manifest.sourceCommitSha='b'.repeat(40),
    x=>x.manifest.workload.minActiveMs=1,
    x=>x.manifest.batches[1].sha256='f'.repeat(64),
  ];
  for(const change of checks){
    const x=fake();change(x);
    assert.throws(()=>checked(x),'mutation must fail closed');
  }
});

test('gate detects duplicate effects, missing receipts, fake processes and missing independent cohorts',()=>{
  for(const mutate of [
    raw=>raw.metrics.hostEffects--,
    raw=>raw.cohorts[0].evidence[0].effects++,
    raw=>raw.cohorts[0].evidence[0].signal='SIGTERM',
    raw=>raw.cohorts[0].evidence[0].successorPids=[11,11],
    raw=>raw.workload.independentWorkerPool=false,
    raw=>raw.cohorts[0].evidence[0].receiptId=null,
  ]){
    const x=fake(),raw=JSON.parse(x.rawFiles[0].toString());
    mutate(raw);
    x.rawFiles[0]=Buffer.from(JSON.stringify(raw));
    x.manifest.batches[0].sha256=digest(x.rawFiles[0]);
    assert.throws(()=>checked(x),'raw evidence mutation must fail closed');
  }
});

test('a tiny or zero-duration synthetic profile can never satisfy minimum soak',()=>{
  const x=fake();
  for(let i=0;i<2;i++){
    const raw=JSON.parse(x.rawFiles[i].toString());
    for(const c of raw.cohorts)c.wallMs=1;
    raw.metrics.totalWallMs=4;
    x.rawFiles[i]=Buffer.from(JSON.stringify(raw));
    x.manifest.batches[i].sha256=digest(x.rawFiles[i]);
    x.manifest.batches[i].activeMs=2;
  }
  x.manifest.metrics.actualActiveMs=4;
  x.manifest.metrics.observedWallMs=4;
  assert.throws(()=>checked(x),/insufficient REAL active SIGKILL process time/);
});


test('match and wake identities can repeat across isolated cohorts and batches',()=>{
  const x=fake();
  // Distinct disposable databases use deterministic fixture IDs; reuse of
  // identities across independently isolated physical cohorts is valid.
  const raw=JSON.parse(x.rawFiles[0].toString('utf8'));
  for(let k=0;k<2;k++){
    const original=raw.cohorts[0].evidence[k];
    raw.cohorts[1].evidence[k].matchId=original.matchId;
    raw.cohorts[1].evidence[k].wakeId=original.wakeId;
    raw.cohorts[1].evidence[k].receiptId=original.receiptId;
  }
  x.rawFiles[0]=Buffer.from(JSON.stringify(raw));
  x.manifest.batches[0].sha256=digest(x.rawFiles[0]);
  assert.equal(checked(x).ok,true);
  // The same IDs remain forbidden inside ONE cohort and PostgreSQL scope.
  raw.cohorts[0].evidence[1].matchId=raw.cohorts[0].evidence[0].matchId;
  x.rawFiles[0]=Buffer.from(JSON.stringify(raw));
  x.manifest.batches[0].sha256=digest(x.rawFiles[0]);
  assert.throws(()=>checked(x),/duplicate logical match identity/);
});
