import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const [osPath, hostPath, rebalancePath, backendPath, outPath] =
  process.argv.slice(2);
if (![osPath, hostPath, rebalancePath, backendPath, outPath]
  .every(p => typeof p === 'string' && p.trim())) {
  throw new Error('Four evidence paths and one fresh manifest destination required');
}
const readJson=async path=>JSON.parse(await readFile(path,'utf8'));
const [os,host]=await Promise.all([readJson(osPath),readJson(hostPath)]);
assert.equal(os.schema,'ei-postgres-os-chaos-soak-v1');
assert.equal(os.status,'completed');
assert.equal(os.workload.cohorts,4);
assert.equal(os.workload.roundsPerCohort,10);
assert.equal(os.workload.totalKillRecoveryRounds,40);
assert.equal(os.metrics.committedUniqueMatches,40);
assert.equal(os.metrics.deliveredReceipts,40);
assert.equal(os.metrics.hostAttempts,40);
assert.equal(os.metrics.hostEffects,40);
assert.equal(os.metrics.duplicateHostAttempts,0);
assert.equal(os.cohorts.length,4);
for(const [index,cohort] of os.cohorts.entries()) {
  assert.equal(cohort.cohort,index+1);
  assert.equal(cohort.rounds,10);
  assert.equal(cohort.evidence.length,10);
  for(const x of cohort.evidence) {
    assert.equal(x.signal,'SIGKILL');
    assert.ok(x.matchId && x.wakeId && x.receiptId);
    assert.equal(x.attempts,1);
    assert.equal(x.effects,1);
    assert.equal(x.successorPids?.length,2);
  }
}
assert.equal(host.schema,'ei-postgres-post-host-effect-os-chaos-v1');
assert.equal(host.status,'completed');
assert.equal(host.rounds,20);
assert.equal(host.killedAfterHostEffectBeforeEiReceipt,20);
assert.equal(host.recoveredDurableReceipts,20);
assert.equal(host.uniqueHostEffects,20);
assert.equal(host.hostAttempts,40);
assert.equal(host.duplicateHostAttempts,20);
assert.equal(host.evidence.length,20);
for(const item of host.evidence) {
  assert.equal(item.signal,'SIGKILL');
  assert.equal(item.attempts,2);
  assert.equal(item.effects,1);
  assert.ok(item.receiptId && item.wakeId && item.matchId);
}
const tapFiles=[];
for(const [name,path] of [['partition-rebalance',rebalancePath],
  ['backend-termination',backendPath]]) {
  const contents=await readFile(path,'utf8');
  assert.match(contents,/^# fail 0\s*$/m,name+' TAP evidence must have zero failed tests');
  assert.match(contents,/^# pass [1-9]\d*\s*$/m,name+' TAP evidence must have executed tests');
  assert.doesNotMatch(contents,/^not ok \d+/m,name+' TAP must have no failed subtest');
  tapFiles.push({name,file:path,sha256:createHash('sha256').update(contents).digest('hex')});
}
const sha=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8',timeout:5000});
assert.equal(sha.status,0);
const sourceSha=sha.stdout.trim();
assert.match(sourceSha,/^[0-9a-f]{40}$/);
if(process.env.GITHUB_SHA) assert.equal(sourceSha,process.env.GITHUB_SHA);
assert.equal(os.sourceCommitSha,sourceSha);
assert.equal(os.postgres.driverVersion,'8.16.3');
const report={
  schema:'ei-pg-worker-chaos-acceptance-evidence-v1',
  status:'completed', sourceCommitSha:sourceSha,
  githubRunId:process.env.GITHUB_RUN_ID??null,
  hardware:os.hardware,postgres:os.postgres,
  boundedRoundEvidence:{
    matchedBeforeWakeOsKill:40,
    hostEffectBeforeEiReceiptOsKill:20,
    durableUniqueMatches:40,
    durableReceiptsAfterMatchRecovery:40,
    uniqueHostEffectsAfterMatchedRecovery:40,
    duplicateHostAttemptsAfterMatchedRecovery:0,
    uniqueHostEffectsAfterReceiptGap:20,
    duplicateDeliveryAttemptsAfterReceiptGap:20,
    receiptGapEffectsBeyondOnePerWake:0,
  },
  files:{osCrash:osPath,postHostCrash:hostPath,tap:tapFiles},
  limits:'Real disposable PG16 and Node OS processes plus fixture host. No real upstream provider/network, DB partition, long-running sustained outage, multi-zone failover, remote external host or production SLO.',
  productionSloCertified:false,
};
await writeFile(outPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({status:'completed',out:outPath,
  killedWorkers:60,sourceCommitSha:sourceSha})+'\n');
