// E47-C: offer polled/verified MCP occurrences to two prewarmed EI workers
// on an independent monotonic schedule with a fail-closed concurrency ceiling.
// This intentionally measures worker ingress, NOT source->host end-to-end SLO.
import {scheduleBoundedSourceOffers} from './e47c-open-loop-pacing.mjs';

const timing=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
export function validateWorkerIngestReceipt(result,expectedWorkerId){
 if(!expectedWorkerId||typeof expectedWorkerId!=='string'||
    result?.accepted!==true||result?.workerId!==expectedWorkerId||
    result.matched!==1||result.persistedDeliveredWakes!==1||
    !timing(result.timings?.ingestToMatchMs)||
    !Array.isArray(result.timings?.matchToWakeSamplesMs)||
    result.timings.matchToWakeSamplesMs.length!==1||
    !timing(result.timings.matchToWakeSamplesMs[0]))
  throw Error('E47C_WORKER_INGRESS_ACK_INVALID');
 return result;
}
export async function scheduleBoundedWorkerIngress({
 count,rate,maxInflight=4,workerIds,send,now,wait,
}={}){
 if(!Array.isArray(workerIds)||workerIds.length!==2||
    workerIds.some(x=>typeof x!=='string'||!x||x.length>128)||
    workerIds[0]===workerIds[1]||typeof send!=='function')
  throw Error('E47C_WORKER_INGRESS_CONFIG_INVALID');
 const job=await scheduleBoundedSourceOffers({
  count,rate,maxInflight,now,wait,
  send:async i=>validateWorkerIngestReceipt(await send(i),workerIds[i%2]),
 });
 const rows=job.rows.map((row,i)=>({
  ...row,workerId:workerIds[i%2],
  // Never persist URLs, bearer tokens or returned external effect payloads.
 }));
 return {...job,rows};
}
