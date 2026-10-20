import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir, cpus, totalmem} from 'node:os';
import path from 'node:path';
import {validateRoundEvidence} from './postgres-os-chaos-evidence.mjs';

const opts=process.argv.slice(2);
const value=name=>{
  const index=opts.indexOf('--'+name);
  return index>=0 ? opts[index+1] : undefined;
};
function integerArg(name, fallback, max) {
  const raw=value(name);
  const n=raw===undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(n) || n<1 || n>max ||
      (raw!==undefined && !/^[1-9]\d*$/.test(raw))) {
    throw new Error(name+' must be an integer from 1 to '+max);
  }
  return n;
}
function fail(message) {
  process.stderr.write(JSON.stringify({
    schema:'ei-pg-chaos-soak-failure-v1',
    status:'failed',reason:message,
  })+'\n');
  process.exitCode=1;
}
function checkoutSourceSha() {
  const sha = spawnSync('git',['rev-parse','HEAD'],{
    encoding:'utf8',timeout:5000,
  });
  const head=sha.stdout?.trim();
  if (sha.status!==0 || !/^[0-9a-f]{40}$/.test(head??'')) {
    throw new Error('cannot verify exact local Git checkout SHA');
  }
  // The user-supplied SHA is never the source of truth. It can only
  // attest to the Git tree which was actually checked out.
  if (process.env.SOAK_SOURCE_SHA && process.env.SOAK_SOURCE_SHA!==head) {
    throw new Error('expected source SHA does not match local Git checkout');
  }
  const dirty = spawnSync('git',['status','--porcelain','--untracked-files=no'],{
    encoding:'utf8',timeout:5000,
  });
  if (dirty.status!==0 || dirty.stdout?.trim()) {
    throw new Error('tracked Git checkout is dirty; cannot attest source SHA');
  }
  return head;
}

let temp=null;
async function main() {
  const cohorts=integerArg('cohorts',1,12);
  const rounds=integerArg('rounds',4,30);
  const perCohortMinutes=integerArg('max-cohort-minutes',10,30);
  const out=value('out');
  if(opts.some((v,i)=>v.startsWith('--')&&![
    '--cohorts','--rounds','--max-cohort-minutes','--out'
  ].includes(v)))throw new Error('unknown option');
  if (!out || typeof out!=='string' || out.startsWith('--'))
    throw new Error('explicit --out artifact path required');
  if(process.env.EI_PG_CHAOS_SOAK_CONFIRM!=='YES_DISPOSABLE_PG' ||
      !process.env.POSTGRES_URL) {
    throw new Error('requires disposable POSTGRES_URL and EI_PG_CHAOS_SOAK_CONFIRM=YES_DISPOSABLE_PG');
  }
  if(process.platform==='win32')
    throw new Error('real SIGKILL process chaos requires POSIX runner');
  const verifiedSourceSha=checkoutSourceSha();
  temp=await mkdtemp(path.join(tmpdir(),'ei-pg-os-soak-'));
  const records=[];
  const start=performance.now();
  for(let index=0;index<cohorts;index++) {
    const artifact=path.join(temp,'cohort-'+index+'.json');
    const child=spawnSync(process.execPath,[
      '--test','test/postgres-os-matched-contenders.test.mjs',
    ],{
      encoding:'utf8',
      maxBuffer:2*1024*1024,
      timeout:perCohortMinutes*60*1000,
      env:{
        ...process.env,
        EI_MATCH_KILL_ROUNDS:String(rounds),
        EI_MATCH_KILL_EVIDENCE_OUT:artifact,
      },
    });
    if(child.status!==0 || child.error) {
      throw new Error('cohort '+(index+1)+' failed: '+(
        child.error?.code??child.signal??child.status??
        'nonzero-test-exit')+
        '; no completion artifact may be trusted');
    }
    const data=JSON.parse(await readFile(artifact,'utf8'));
    assert.equal(data.schema,'ei-postgres-os-matched-contenders-v1');
    assert.equal(data.rounds,rounds);
    assert.equal(data.killedAfterPersistedMatch,rounds);
    assert.equal(data.committedUniqueMatches,rounds);
    assert.equal(data.recoveredDurableReceipts,rounds);
    assert.equal(data.externalHostAttempts,rounds);
    assert.equal(data.externalHostEffects,rounds);
    assert.equal(data.observedDuplicateHostAttempts,0);
    validateRoundEvidence(data,rounds);
    assert.ok(Number.isFinite(data.totalWallMs)&&data.totalWallMs>0);
    records.push({cohort:index+1,rounds,
      observedHostEffects:data.externalHostEffects,
      observedHostAttempts:data.externalHostAttempts,
      duplicateHostAttempts:data.observedDuplicateHostAttempts,
      wallMs:data.totalWallMs,
      // Preserve original per-round evidence rather than reporting only
      // aggregate successes and masking a missing wake in one cohort.
      evidence:data.evidence,
    });
  }
  const result={
    schema:'ei-postgres-os-chaos-soak-v1',
    status:'completed',
    sourceCommitSha:verifiedSourceSha,
    hardware:{
      platform:process.platform,
      cpuModel:cpus()[0]?.model??'unknown',
      logicalCpuCount:cpus().length,
      totalMemoryBytes:totalmem(),
      node:process.version,
    },
    githubRunId:process.env.GITHUB_RUN_ID??null,
    workload:{cohorts,roundsPerCohort:rounds,
      totalKillRecoveryRounds:cohorts*rounds,
      physicalOsProcesses:true,postgresSharedState:true,
      independentWorkerPool:true},
    metrics:{
      committedUniqueMatches:cohorts*rounds,
      deliveredReceipts:cohorts*rounds,
      hostAttempts:cohorts*rounds,
      hostEffects:cohorts*rounds,
      duplicateHostAttempts:0,
      totalWallMs:performance.now()-start,
    },
    limits:'isolated single PG16 service, OS SIGKILL after persisted match, two competing OS workers and fixture host ledger; NOT provider transport, upstream cursor, physical DB failover/partition or real external host effect',
    cohorts:records,
    productionSloCertified:false,
  };
  // Never create a success-shaped artifact if ANY cohort or its cleanup failed.
  await writeFile(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  process.stdout.write(JSON.stringify({status:'completed',
    totalKillRecoveryRounds:cohorts*rounds,out})+'\n');
}
try{
  await main();
}catch(error){
  fail(String(error?.message??error).replace(/postgres(?:ql)?:\/\/\S+/gi,'[redacted-postgres-url]'));
}finally{
  if(temp)await rm(temp,{recursive:true,force:true});
}
