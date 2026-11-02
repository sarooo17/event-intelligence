import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
export const sha256=value=>createHash('sha256').update(value).digest('hex');
export function safeProfileConfig(input={}){
 const counts=input.counts??[1000,10000,100000];
 const samples=input.samplesPerPhase??150;
 const maxRequests=input.maxHostEvents??150;
 if(!Array.isArray(counts)||counts.length!==3||
    counts.some((n,i)=>!Number.isSafeInteger(n)||n<1000||n>100000||
      (i>0&&n<=counts[i-1]))||
    !Number.isSafeInteger(samples)||samples<100||samples>1500||
    !Number.isSafeInteger(maxRequests)||maxRequests<10||maxRequests>2000)
  throw new RangeError('Invalid E48-B isolated representative workload');
 return {counts:[...counts],samplesPerPhase:samples,maxHostEvents:maxRequests};
}
export function latencyStatistics(observations){
 if(!Array.isArray(observations)||!observations.length||
   observations.some(x=>!Number.isFinite(x)||x<0))
  throw new TypeError('Measured nonnegative latency samples required');
 const a=[...observations].sort((x,y)=>x-y);
 const p=q=>Math.round(a[Math.min(a.length-1,Math.ceil(q*a.length)-1)]*1000)/1000;
 return {n:a.length,p50:p(.5),p95:p(.95),p99:p(.99),
  min:p(0),max:p(1),
  mean:Math.round(a.reduce((sum,x)=>sum+x,0)/a.length*1000)/1000};
}
export function classifyInspectorError(e){
 const code=typeof e?.code==='string'?e.code:'UNKNOWN';
 return /^[-_A-Z0-9]{1,90}$/.test(code)?code:'UNKNOWN';
}
export async function profileFullInspector({inspector,ids,iterations,
  onSample}={}){
 if(typeof inspector?.inspect!=='function'||!Array.isArray(ids)||!ids.length||
   ids.some(id=>typeof id!=='string'||!id)||
   !Number.isSafeInteger(iterations)||iterations<1||iterations>2500)
  throw new TypeError('Full inspector instance, ids and bounded iterations required');
 const samples=[],outcomes={};let successes=0,refusals=0;
 const before=process.cpuUsage(),memoryBefore=process.memoryUsage();
 let rssPeak=memoryBefore.rss;
 for(let i=0;i<iterations;i++){
  const id=ids[(i*37)%ids.length];
  const start=performance.now();
  let outcome='passed',code=null;
  try{
   const result=await inspector.inspect({triggerId:'e48-inspected',version:'1',
     matchId:id});
   if(result?.trigger?.triggerId!=='e48-inspected'||result?.match?.matchId!==id)
    throw Object.assign(new Error('Inspector response identity mismatch'),
      {code:'INSPECT_RESULT_IDENTITY_MISMATCH'});
   if(!result?.diagnosisV2?.kind||!result?.lineage)
    throw Object.assign(new Error('Incomplete full inspector path'),
      {code:'INSPECT_FULL_PATH_INCOMPLETE'});
   successes++;
  }catch(e){refusals++;outcome='refused';code=classifyInspectorError(e);}
  const duration=Math.round((performance.now()-start)*1000)/1000;
  const rss=process.memoryUsage().rss;
  rssPeak=Math.max(rssPeak,rss);
  const sample={index:i,elapsedMs:duration,outcome,...(code?{code}:{})};
  samples.push(sample);
  outcomes[code??'PASS']=(outcomes[code??'PASS']??0)+1;
  if(onSample)await onSample(sample);
 }
 const cpu=process.cpuUsage(before),mem=process.memoryUsage();
 return {
  fullInspectorCalls:iterations,successes,refusals,
  percentileLatencyMs:latencyStatistics(samples.map(x=>x.elapsedMs)),
  processCpuMicros:{user:cpu.user,system:cpu.system},
  processRssBytes:{baseline:memoryBefore.rss,after:mem.rss,peak:rssPeak},
  processHeapUsedBytes:{baseline:memoryBefore.heapUsed,after:mem.heapUsed},
  outcomeCounts:outcomes,samples,
  processCpuSharedWithHostLoad:true,
  measurementIncludesFullInspector:true,
 };
}
