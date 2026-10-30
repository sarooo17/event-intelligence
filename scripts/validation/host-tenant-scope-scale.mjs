// EI-owned reference diagnostic, not PostgreSQL HA or production SLO.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {createEventIntelligenceHost,PersistentEventStore} from '../host-integration.mjs';
const scriptPath=fileURLToPath(import.meta.url),schema='ei.host-scope-coldstart.v1';
const integer=(x,hi)=>{
  const n=Number(x);
  if(!Number.isSafeInteger(n)||n<1||n>hi)throw RangeError('invalid integer');
  return n;
};
async function seedScopes(tier,dir){
  const store=new PersistentEventStore(dir);
  await store.init();
  for(let i=1;i<tier;i++)await store.forScope('tenant-'+i);
  assert.equal((await store.listScopeIds()).length,tier);
  await store.close?.();
}
async function measureScopes(tier,dir){
  // Unlike the seeder, this OS process has never loaded any tenant store.
  // Observe real timer resources, including the unref'ed interval handles.
  const nativeSetInterval=globalThis.setInterval;
  const nativeClearInterval=globalThis.clearInterval;
  const observed=new Set();
  let created=0,closed=0,host;
  globalThis.setInterval=(...args)=>{
    const handle=nativeSetInterval(...args);
    created++;
    observed.add(handle);
    return handle;
  };
  globalThis.clearInterval=(handle)=>{
    if(observed.delete(handle))closed++;
    return nativeClearInterval(handle);
  };
  try{
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
    let temporal=0,retry=0;
    for(const id of scopes){
      const c=(await host.scope(id)).runtime;
      contexts.push(c);
      if(observed.has(c.temporalScheduler.timer))temporal++;
      if(observed.has(c.wakeRetryScheduler.timer))retry++;
    }
    assert.equal(temporal,tier);
    assert.equal(retry,tier);
    const atEndOfStartup=observed.size;
    const stop=performance.now();
    await host.close();
    host=null;
    const shutdownMs=performance.now()-stop;
    for(const c of contexts){
      assert.equal(c.temporalScheduler.timer,null);
      assert.equal(c.wakeRetryScheduler.timer,null);
    }
    // Actual interval handles must be closed, not just scheduler fields reset.
    assert.equal(observed.size,0,'interval handles leaked after close');
    return {
      schema,scopeCount:tier,loadedScopes:scopes.length,
      startupMs:+startupMs.toFixed(3),shutdownMs:+shutdownMs.toFixed(3),
      rssBeforeBytes:before.rss,rssAfterBytes:after.rss,
      rssDeltaBytes:after.rss-before.rss,heapDeltaBytes:after.heapUsed-before.heapUsed,
      activeTemporalTimers:temporal,activeWakeRetryTimers:retry,
      observedIntervalHandlesAtStartup:atEndOfStartup,
      createdIntervalHandles:created,clearedIntervalHandles:closed,
      timersAfterClose:observed.size,
      persistentStore:'JSONL-reference',retainedWakeAfterRestartVerified:false,
      independentlyMaintainedHost:false,productionSloCertified:false,
    };
  }finally{
    if(host)await host.close().catch(()=>{});
    globalThis.setInterval=nativeSetInterval;
    globalThis.clearInterval=nativeClearInterval;
  }
}
function parse(argv){
  const r={tiers:[1,10,100],samples:3,child:null,seed:null,dir:null};
  for(const arg of argv){
    if(arg.startsWith('--tiers='))r.tiers=arg.slice(8).split(',').map(x=>integer(x,1000));
    else if(arg.startsWith('--samples='))r.samples=integer(arg.slice(10),8);
    else if(arg.startsWith('--child='))r.child=integer(arg.slice(8),1000);
    else if(arg.startsWith('--seed='))r.seed=integer(arg.slice(7),1000);
    else if(arg.startsWith('--dir='))r.dir=arg.slice(6);
    else throw Error('unknown argument');
  }
  if(new Set(r.tiers).size!==r.tiers.length)throw Error('duplicate tier');
  if((r.child!==null||r.seed!==null)&&(!r.dir||r.dir.length>4096))
    throw Error('seed/child requires explicit ephemeral directory');
  return r;
}
const summarize=values=>{
  const sorted=[...values].sort((a,b)=>a-b);
  return {samples:sorted.length,min:sorted[0],
    median:sorted[Math.floor((sorted.length-1)/2)],max:sorted.at(-1)};
};
async function main(){
  const a=parse(process.argv.slice(2));
  if(a.seed!==null){await seedScopes(a.seed,a.dir);return;}
  if(a.child!==null){
    process.stdout.write(JSON.stringify(await measureScopes(a.child,a.dir))+'\n');
    return;
  }
  const tiers=[];
  for(const scopeCount of a.tiers){
    const samples=[];
    for(let i=0;i<a.samples;i++){
      const dir=mkdtempSync(join(tmpdir(),'ei-scope-benchmark-'));
      try{
        // Both seed and measurement are SEPARATE fresh Node OS processes.
        execFileSync(process.execPath,[scriptPath,'--seed='+scopeCount,
          '--dir='+dir],{cwd:process.cwd(),timeout:120000});
        const raw=execFileSync(process.execPath,[
          '--expose-gc',scriptPath,'--child='+scopeCount,'--dir='+dir,
        ],{cwd:process.cwd(),encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
        const item=JSON.parse(raw);
        assert.equal(item.schema,schema);
        assert.equal(item.scopeCount,scopeCount);
        assert.equal(item.timersAfterClose,0);
        samples.push(item);
      }finally{rmSync(dir,{recursive:true,force:true});}
    }
    tiers.push({scopeCount,
      coldStartMs:summarize(samples.map(x=>x.startupMs)),
      shutdownMs:summarize(samples.map(x=>x.shutdownMs)),
      rssDeltaBytes:summarize(samples.map(x=>x.rssDeltaBytes)),
      actualObservedStartupIntervals:summarize(
        samples.map(x=>x.observedIntervalHandlesAtStartup)),
      samples,
    });
  }
  const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{
    cwd:process.cwd(),encoding:'utf8',timeout:5000}).trim();
  process.stdout.write(JSON.stringify({schema,sourceCommit,node:process.version,
    platform:process.platform,arch:process.arch,tiers,
    limitations:['EI-authored fixture, separate seed and measurement OS processes',
      'JSONL reference only; NOT PG16 multiworker nor independent tenant SaaS',
      'Empty restored scopes; no due wake, deadline, MCP source or replay workload',
      'Not a production latency/billing/security/host certificate'],
    productionSloCertified:false,independentHostVerified:false},null,2)+'\n');
}
main().catch(error=>{console.error('HOST_SCOPE_BENCHMARK_FAILED:',error);
  process.exitCode=1;});