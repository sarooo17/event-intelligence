// Source-pinned EI-maintained reference benchmark; NOT a production SLO.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {createEventIntelligenceHost,PersistentEventStore} from '../host-integration.mjs';
const script=fileURLToPath(import.meta.url),schema='ei.host-scope-coldstart.v1';
const integer=(x,hi)=>{const n=Number(x);if(!Number.isSafeInteger(n)||n<1||n>hi)throw RangeError('invalid integer');return n;};
async function sample(tier){
  const dir=await mkdtemp(join(tmpdir(),'ei-scope-benchmark-'));
  let host;
  try{
    const seed=new PersistentEventStore(dir);
    await seed.init();
    for(let i=1;i<tier;i++)await seed.forScope('tenant-'+i);
    assert.equal((await seed.listScopeIds()).length,tier);
    await seed.close?.();
    global.gc?.();
    const before=process.memoryUsage(),start=performance.now();
    host=await createEventIntelligenceHost({
      dataDir:dir,
      env:{TYPESAFE_API_KEY:'',RUNTIME_WAKE_TARGETS_JSON:'{}',
        TEMPORAL_TICK_MS:'100000',WAKE_RETRY_TICK_MS:'100000'},
    });
    const startupMs=performance.now()-start;
    global.gc?.();
    const after=process.memoryUsage();
    const scopes=host.loadedScopes();
    assert.equal(scopes.length,tier);
    const contexts=[];
    for(const id of scopes){
      const view=await host.scope(id);
      contexts.push(view.runtime);
      assert(view.runtime.temporalScheduler.timer);
      assert(view.runtime.wakeRetryScheduler.timer);
    }
    const stop=performance.now();
    await host.close();
    host=null;
    for(const c of contexts){
      assert.equal(c.temporalScheduler.timer,null);
      assert.equal(c.wakeRetryScheduler.timer,null);
    }
    return {schema,scopeCount:tier,loadedScopes:scopes.length,
      startupMs:+startupMs.toFixed(3),shutdownMs:+(performance.now()-stop).toFixed(3),
      rssBeforeBytes:before.rss,rssAfterBytes:after.rss,
      rssDeltaBytes:after.rss-before.rss,heapDeltaBytes:after.heapUsed-before.heapUsed,
      activeTemporalTimers:tier,activeWakeRetryTimers:tier,timersAfterClose:0,
      persistentStore:'JSONL-reference',retainedWakeAfterRestartVerified:false,
      independentlyMaintainedHost:false,productionSloCertified:false};
  }finally{
    if(host)await host.close().catch(()=>{});
    await rm(dir,{recursive:true,force:true});
  }
}
function parse(argv){
  const r={tiers:[1,10,100],samples:3,child:null};
  for(const a of argv){
    if(a.startsWith('--tiers='))r.tiers=a.slice(8).split(',').map(x=>integer(x,1000));
    else if(a.startsWith('--samples='))r.samples=integer(a.slice(10),8);
    else if(a.startsWith('--child='))r.child=integer(a.slice(8),1000);
    else throw Error('unknown argument '+a);
  }
  if(new Set(r.tiers).size!==r.tiers.length)throw Error('duplicate tier');
  return r;
}
const summarize=values=>{
  const v=[...values].sort((a,b)=>a-b);
  return {samples:v.length,min:v[0],median:v[Math.floor((v.length-1)/2)],max:v.at(-1)};
};
async function main(){
  const args=parse(process.argv.slice(2));
  if(args.child!==null){
    process.stdout.write(JSON.stringify(await sample(args.child))+'\n');
    return;
  }
  const tiers=[];
  for(const scopeCount of args.tiers){
    const samples=[];
    for(let i=0;i<args.samples;i++){
      const result=execFileSync(process.execPath,[
        '--expose-gc',script,'--child='+scopeCount,
      ],{cwd:process.cwd(),encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
      const obj=JSON.parse(result);
      assert.equal(obj.schema,schema);
      assert.equal(obj.scopeCount,scopeCount);
      samples.push(obj);
    }
    tiers.push({scopeCount,timersPerWorker:2*scopeCount,
      coldStartMs:summarize(samples.map(x=>x.startupMs)),
      shutdownMs:summarize(samples.map(x=>x.shutdownMs)),
      rssDeltaBytes:summarize(samples.map(x=>x.rssDeltaBytes)),samples});
  }
  const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{
    cwd:process.cwd(),encoding:'utf8',timeout:5000}).trim();
  process.stdout.write(JSON.stringify({schema,sourceCommit,node:process.version,
    platform:process.platform,arch:process.arch,tiers,
    limitations:['EI-maintained fixture and separate OS-process samples',
      'Reference JSONL only, NOT PG16 multiworker or independent SaaS',
      'Only empty restored scopes; no pending wake, deadline, source or replay',
      'Not a production p99, billing or independent host/security certificate'],
    productionSloCertified:false,independentHostVerified:false},null,2)+'\n');
}
main().catch(e=>{console.error('HOST_SCOPE_BENCHMARK_FAILED:',e);process.exitCode=1;});