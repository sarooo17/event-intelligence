#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {cpus,totalmem} from 'node:os';
import {join,resolve} from 'node:path';

const args=process.argv.slice(2);
const arg=(name,fallback)=>{
  const index=args.indexOf('--'+name);
  return index<0?fallback:args[index+1];
};
const bounded=(name,fallback,min,max)=>{
  const raw=arg(name,String(fallback));
  if(typeof raw!=='string'||!/^[1-9]\d*$/.test(raw)||
      !Number.isSafeInteger(Number(raw))||
      Number(raw)<min||Number(raw)>max){
    throw Error('--'+name+' must be integer '+min+'..'+max);
  }
  return Number(raw);
};
let activeGroup=null;
let interrupted=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
  interrupted=true;
  process.exitCode=signal==='SIGINT'?130:143;
  activeGroup?.();
});
function alive(){
  if(interrupted)throw Error('continuous PG OS soak interrupted');
}
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const shaFromCheckout=()=>{
  const cmd=spawnSync('git',['rev-parse','HEAD'],{
    encoding:'utf8',timeout:5000,
  });
  const sha=cmd.stdout?.trim();
  assert.equal(cmd.status,0,'cannot attest local commit');
  assert.match(sha,/^[0-9a-f]{40}$/);
  if(process.env.SOAK_SOURCE_SHA!==sha)throw Error(
    'SOAK_SOURCE_SHA must equal actual exact checked-out HEAD');
  const status=spawnSync('git',['status','--porcelain','--untracked-files=no'],{
    encoding:'utf8',timeout:5000,
  });
  assert.equal(status.status,0);
  assert.equal(status.stdout.trim(),'','tracked checkout must be clean');
  return sha;
};
function execOne({batchPath,cohorts,rounds,timeoutMs}){
  return new Promise((done,reject)=>{
    const argv=[
      'scripts/evidence/postgres-os-chaos-soak.mjs',
      '--cohorts',String(cohorts),
      '--rounds',String(rounds),
      '--max-cohort-minutes','15',
      '--out',batchPath,
    ];
    const child=spawn(process.execPath,argv,{
      detached:process.platform!=='win32',
      stdio:['ignore','pipe','pipe'],
      env:process.env,
    });
    let output='',failed=null,settled=false;
    let terminationRequested=false,escalation=null;
    const kill=()=>{
      if(!child.pid||settled||terminationRequested)return;
      terminationRequested=true;
      try {
        // The child runner owns a SECOND, detached process group with the
        // active SIGKILL cohort. Forward SIGTERM first so its signal handler
        // terminates and reaps that group before the intermediate process
        // exits. Sending immediate SIGKILL would orphan the cohort.
        if(process.platform!=='win32')process.kill(-child.pid,'SIGTERM');
        else child.kill('SIGTERM');
      }catch(error){if(error.code!=='ESRCH')failed??=error.message;}
      escalation=setTimeout(()=>{
        if(settled)return;
        try{
          if(process.platform!=='win32')process.kill(-child.pid,'SIGKILL');
          else child.kill('SIGKILL');
        }catch(error){if(error.code!=='ESRCH')failed??=error.message;}
      },10_000);
      escalation.unref();
    };
    activeGroup=kill;
    const timer=setTimeout(()=>{
      failed='batch timed out';
      kill();
    },timeoutMs);
    const append=chunk=>{
      // Avoid runaway stdout/stderr in case of child runtime failure.
      if(output.length>4096){failed='batch output size exceeded';kill();return;}
      output+=chunk.toString();
    };
    child.stdout.on('data',append);
    child.stderr.on('data',append);
    const settle=error=>{
      if(settled)return;
      settled=true;
      clearTimeout(timer);
      if(escalation)clearTimeout(escalation);
      if(activeGroup===kill)activeGroup=null;
      if(error||interrupted){
        kill();
        reject(new Error('continuous batch failed: '+
          String(error||'interrupted')+'; '+output.slice(-1200)));
      }else done();
    };
    child.once('error',e=>settle(e?.message));
    child.once('close',(code,signal)=>
      settle(failed||(code===0?null:signal||String(code))));
    if(interrupted)kill();
  });
}

async function main(){
  const minActiveSeconds=bounded('min-active-seconds',600,600,1800);
  const maxBatches=bounded('max-batches',120,1,120);
  const cohorts=bounded('cohorts',4,2,12);
  const rounds=bounded('rounds',10,2,30);
  const outArg=arg('out-dir',null);
  if(!outArg||outArg.startsWith('--')||
      args.some(v=>v.startsWith('--')&&![
        '--min-active-seconds','--max-batches','--cohorts','--rounds',
        '--out-dir',
      ].includes(v)))throw Error('supported flags: --out-dir, --min-active-seconds, --max-batches, --cohorts, --rounds');
  if(process.env.EI_PG_CHAOS_SOAK_CONFIRM!=='YES_DISPOSABLE_PG' ||
      !process.env.POSTGRES_URL)throw Error(
    'disposable PostgreSQL required; explicitly set EI_PG_CHAOS_SOAK_CONFIRM');
  if(process.platform==='win32')throw Error('real process SIGKILL requires POSIX');
  const sourceCommitSha=shaFromCheckout();
  const outDir=resolve(outArg);
  // A partial old success artifact must never be mistaken for a fresh run.
  await mkdir(outDir,{recursive:false,mode:0o700});
  const batches=[];
  let activeMs=0,totalRounds=0,postgres=null;
  const started=new Date().toISOString(),start=performance.now();
  for(let index=0;index<maxBatches && activeMs<minActiveSeconds*1000;index++){
    alive();
    const rawFile='batch-'+String(index+1).padStart(4,'0')+'.json';
    const batchPath=join(outDir,rawFile);
    await execOne({batchPath,cohorts,rounds,
      timeoutMs:cohorts*15*60_000+90_000});
    alive();
    const original=await readFile(batchPath);
    if(original.length<2 || original.length>32*1024*1024)
      throw Error('saved raw evidence violates bounded artifact budget');
    const data=JSON.parse(original.toString('utf8'));
    if(data.schema!=='ei-postgres-os-chaos-soak-v1' ||
        data.status!=='completed' ||
        data.sourceCommitSha!==sourceCommitSha ||
        data.workload?.cohorts!==cohorts ||
        data.workload?.roundsPerCohort!==rounds ||
        data.workload?.totalKillRecoveryRounds!==cohorts*rounds ||
        data.metrics?.deliveredReceipts!==cohorts*rounds ||
        data.metrics?.hostEffects!==cohorts*rounds ||
        data.metrics?.duplicateHostAttempts!==0 ||
        !Array.isArray(data.cohorts)||data.cohorts.length!==cohorts)
      throw Error('inner real PG16 worker campaign produced incomplete evidence');
    postgres??=data.postgres;
    if(data.postgres?.serverVersionNum!==postgres?.serverVersionNum)
      throw Error('changed PostgreSQL version mid-campaign');
    const measured=data.cohorts.reduce((sum,c)=>{
      if(!Number.isFinite(c.wallMs)||c.wallMs<=0 ||
          c.evidence?.length!==rounds)return NaN;
      return sum+c.wallMs;
    },0);
    if(!Number.isFinite(measured)||measured<=0 ||
        measured>data.metrics.totalWallMs+100)
      throw Error('untrusted claimed active SIGKILL duration');
    activeMs+=measured;
    totalRounds+=cohorts*rounds;
    batches.push({
      batch:index+1,rawFile,sha256:sha256(original),
      activeMs:measured,crashRecoveryRounds:cohorts*rounds,
    });
  }
  alive();
  if(activeMs<minActiveSeconds*1000)throw Error(
    'insufficient 600s active process-chaos duration under max-batches cap');
  // Success is only published after ALL raw batches are durably written and
  // checked. A failed/cancelled run has no success-shaped manifest.
  const manifest={
    schema:'ei-postgres-os-600s-continuous-v1',
    status:'completed',sourceCommitSha,postgres,
    startedAt:started,finishedAt:new Date().toISOString(),
    hardware:{node:process.version,cpuModel:cpus()[0]?.model??'unknown',
      logicalCpuCount:cpus().length,totalMemoryBytes:totalmem()},
    workload:{physicalOsProcesses:true,sharedPostgres16:true,
      continuousNoSyntheticDelay:true,cohortsPerBatch:cohorts,
      roundsPerCohort:rounds,batchCount:batches.length,
      minActiveMs:minActiveSeconds*1000},
    metrics:{actualActiveMs:activeMs,actualCrashRecoveryRounds:totalRounds,
      verifiedReceipts:totalRounds,hostEffects:totalRounds,
      unaccountedDuplicateEffects:0,
      observedWallMs:performance.now()-start},
    batches,externalProviderMeasured:false,externalHostMeasured:false,
    productionSloCertified:false,
    limitations:'actual process SIGKILL and two competing independent OS workers on isolated PostgreSQL 16; fixture host only; NO remote provider, multi-region partition, DB failover or production SLO',
  };
  await writeFile(join(outDir,'manifest.json'),
    JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  process.stdout.write(JSON.stringify({
    status:'completed',activeMs,rounds:totalRounds,
    batchCount:batches.length,productionSloCertified:false,
  })+'\n');
}
try{await main();}
catch(e){
  process.stderr.write('OS_CHAOS_600S_RUN_FAILED: '+String(e?.message??e)
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi,'[REDACTED_PG_URL]')+'\n');
  process.exitCode ||= 1;
}
