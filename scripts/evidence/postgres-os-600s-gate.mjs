#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Independent, non-certifying verifier for continuous OS SIGKILL campaign
 * evidence. Every raw batch must be present and byte-hash pinned.
 *
 * NOTE: This is a REAL PG16 independent-process crash/recovery fixture.
 * Provider transport, remote host effects and DB failover are NOT measured;
 * it must never be used to certify production SLO or full #47.
 */
export const MIN_ACTIVE_MS=600_000;
const HEX=/^[0-9a-f]{64}$/;
const SHA=/^[0-9a-f]{40}$/;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function assertRawRound(row,number,seenMatches,seenWakes) {
  assert.equal(row?.round,number,'missing or reordered OS SIGKILL round');
  assert.equal(row.signal,'SIGKILL');
  assert.ok(Number.isSafeInteger(row.killedPid)&&row.killedPid>0);
  assert.ok(Array.isArray(row.successorPids)&&row.successorPids.length===2);
  assert.ok(row.successorPids.every(pid=>Number.isSafeInteger(pid)&&pid>0));
  assert.equal(new Set([row.killedPid,...row.successorPids]).size,3);
  assert.equal(row.attempts,1);
  assert.equal(row.effects,1);
  assert.equal(row.deliveryGeneration,1);
  assert.ok(typeof row.matchId==='string'&&row.matchId.length>0);
  assert.ok(typeof row.wakeId==='string'&&row.wakeId.length>0);
  assert.equal(row.receiptId,'fixture-external:'+row.wakeId);
  assert.ok(!seenMatches.has(row.matchId),'duplicate logical match identity');
  assert.ok(!seenWakes.has(row.wakeId),'duplicate wake identity');
  seenMatches.add(row.matchId);
  seenWakes.add(row.wakeId);
}

export function verifyPostgresLongOsChaosEvidence(manifest,rawFiles,{
  expectedSourceSha,minActiveMs=MIN_ACTIVE_MS,
}={}){
  const check=(condition,message)=>assert.ok(condition,message);
  check(SHA.test(expectedSourceSha),'independent exact source SHA required');
  check(Number.isSafeInteger(minActiveMs)&&minActiveMs>=MIN_ACTIVE_MS,
    '600s minimum cannot be weakened');
  assert.equal(manifest?.schema,'ei-postgres-os-600s-continuous-v1');
  assert.equal(manifest.status,'completed');
  assert.equal(manifest.sourceCommitSha,expectedSourceSha);
  assert.equal(manifest.productionSloCertified,false);
  assert.equal(manifest.externalProviderMeasured,false);
  assert.equal(manifest.externalHostMeasured,false);
  check(manifest?.workload?.physicalOsProcesses===true,'real OS processes required');
  check(manifest?.workload?.sharedPostgres16===true,'actual PG16 required');
  check(manifest?.workload?.continuousNoSyntheticDelay===true,
    'no artificial delay to fill the duration');
  check(Number.isSafeInteger(manifest.workload.cohortsPerBatch) &&
    manifest.workload.cohortsPerBatch>=2,'independent process cohorts required');
  check(Number.isSafeInteger(manifest.workload.roundsPerCohort) &&
    manifest.workload.roundsPerCohort>=2,'real crash rounds required');
  check(Number.isSafeInteger(manifest.workload.batchCount) &&
    manifest.workload.batchCount>=1&&manifest.workload.batchCount<=120);
  check(Number.isSafeInteger(manifest.workload.minActiveMs)&&
    manifest.workload.minActiveMs>=minActiveMs);
  check(Array.isArray(manifest.batches) &&
    manifest.batches.length===manifest.workload.batchCount);
  check(Array.isArray(rawFiles) && rawFiles.length===manifest.batches.length);
  check(typeof manifest.postgres?.serverVersion==='string' &&
    /^16(?:\.|$)/.test(manifest.postgres.serverVersion.trim()),'actual PG16');
  check(Number.isSafeInteger(manifest.postgres.serverVersionNum) &&
    Math.floor(manifest.postgres.serverVersionNum/10000)===16);
  check(typeof manifest?.hardware?.node==='string' &&
    /^v22\./.test(manifest.hardware.node),'record Node22 runtime');
  const seenMatches=new Set(),seenWakes=new Set();
  let activeMs=0,totalRounds=0,wallMs=0;
  for(let i=0;i<manifest.batches.length;i++){
    const entry=manifest.batches[i];
    assert.equal(entry?.batch,i+1);
    assert.equal(entry.rawFile,'batch-'+String(i+1).padStart(4,'0')+'.json');
    check(HEX.test(entry.sha256),'raw SHA-256 digest');
    check(Buffer.isBuffer(rawFiles[i])&&rawFiles[i].length>0 &&
      rawFiles[i].length<=32*1024*1024,'bounded saved raw batch bytes');
    assert.equal(entry.sha256,hash(rawFiles[i]),'raw bytes differ from manifest');
    const raw=JSON.parse(rawFiles[i].toString('utf8'));
    assert.equal(raw.schema,'ei-postgres-os-chaos-soak-v1');
    assert.equal(raw.status,'completed');
    assert.equal(raw.productionSloCertified,false);
    assert.equal(raw.sourceCommitSha,expectedSourceSha);
    assert.equal(raw.postgres.serverVersionNum,manifest.postgres.serverVersionNum);
    assert.equal(raw.workload.physicalOsProcesses,true);
    assert.equal(raw.workload.postgresSharedState,true);
    assert.equal(raw.workload.independentWorkerPool,true);
    assert.equal(raw.workload.cohorts,manifest.workload.cohortsPerBatch);
    assert.equal(raw.workload.roundsPerCohort,manifest.workload.roundsPerCohort);
    const rounds=raw.workload.cohorts*raw.workload.roundsPerCohort;
    assert.equal(raw.workload.totalKillRecoveryRounds,rounds);
    assert.equal(raw.cohorts?.length,raw.workload.cohorts);
    assert.equal(raw.metrics.committedUniqueMatches,rounds);
    assert.equal(raw.metrics.deliveredReceipts,rounds);
    assert.equal(raw.metrics.hostAttempts,rounds);
    assert.equal(raw.metrics.hostEffects,rounds);
    assert.equal(raw.metrics.duplicateHostAttempts,0);
    check(Number.isFinite(raw.metrics.totalWallMs) &&
      raw.metrics.totalWallMs>0,'measured batch wall duration');
    let batchActiveMs=0;
    for(let j=0;j<raw.cohorts.length;j++){
      const cohort=raw.cohorts[j];
      assert.equal(cohort.cohort,j+1);
      assert.equal(cohort.rounds,raw.workload.roundsPerCohort);
      assert.equal(cohort.observedHostEffects,cohort.rounds);
      assert.equal(cohort.observedHostAttempts,cohort.rounds);
      assert.equal(cohort.duplicateHostAttempts,0);
      check(Number.isFinite(cohort.wallMs)&&cohort.wallMs>0,
        'actual process cohort wall time');
      assert.equal(cohort.evidence?.length,cohort.rounds);
      for(let k=0;k<cohort.rounds;k++){
        assertRawRound(cohort.evidence[k],k,seenMatches,seenWakes);
      }
      batchActiveMs+=cohort.wallMs;
    }
    check(batchActiveMs>0&&batchActiveMs<=raw.metrics.totalWallMs+100,
      'active duration must be measured within the batch');
    assert.equal(entry.activeMs,batchActiveMs);
    assert.equal(entry.crashRecoveryRounds,rounds);
    activeMs+=batchActiveMs;
    totalRounds+=rounds;
    wallMs+=raw.metrics.totalWallMs;
  }
  assert.equal(manifest.metrics.actualActiveMs,activeMs);
  assert.equal(manifest.metrics.actualCrashRecoveryRounds,totalRounds);
  assert.equal(manifest.metrics.verifiedReceipts,totalRounds);
  assert.equal(manifest.metrics.hostEffects,totalRounds);
  assert.equal(manifest.metrics.unaccountedDuplicateEffects,0);
  check(activeMs>=minActiveMs,'insufficient REAL active SIGKILL process time');
  check(wallMs>=activeMs,'active duration cannot exceed executed batch time');
  check(manifest.metrics.observedWallMs>=activeMs,
    'observed total wall time cannot be shorter than real process time');
  return Object.freeze({
    ok:true,activeMs,rounds:totalRounds,batches:rawFiles.length,
    productionSloCertified:false,
    limitations:'isolated PG16, independent OS worker SIGKILL, local fixture host only',
  });
}

if(process.argv[1]?.endsWith('postgres-os-600s-gate.mjs')){
  const [dir,expectedSourceSha]=process.argv.slice(2);
  try{
    assert.ok(dir&&expectedSourceSha,'usage: gate EVIDENCE_DIR EXACT_CHECKOUT_SHA');
    const manifest=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8'));
    const files=readdirSync(dir);
    assert.equal(files.filter(n=>/^batch-\d{4}\.json$/.test(n)).length,
      manifest.workload.batchCount,'no missing or extra raw batches');
    const raws=manifest.batches.map(x=>readFileSync(join(dir,x.rawFile)));
    const checked=verifyPostgresLongOsChaosEvidence(manifest,raws,{
      expectedSourceSha,
    });
    process.stdout.write(JSON.stringify(checked)+'\n');
  }catch(error){
    process.stderr.write('OS_CHAOS_600S_GATE_FAILED: '+
      String(error?.message??error)+'\n');
    process.exitCode=1;
  }
}
