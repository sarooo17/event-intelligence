// E47-C: offer polled/verified MCP occurrences to two prewarmed EI workers
// on an independent monotonic schedule with a fail-closed concurrency ceiling.
// This intentionally measures worker ingress, NOT source->host end-to-end SLO.
import {scheduleBoundedSourceOffers} from './e47c-open-loop-pacing.mjs';
import {validateDeferredWorkerAdmission} from './e47c-durable-ack-drain.mjs';

const timing=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
export function validateWorkerIngestReceipt(result,expectedWorkerId){
 // Fixed, non-payload-bearing codes distinguish what the *response* failed
 // to prove. They do NOT imply missing durable wakes or host effects.
 if(!expectedWorkerId||typeof expectedWorkerId!=='string')
  throw Error('E47C_WORKER_ACK_CONFIG_INVALID');
 if(result?.accepted!==true)
  throw Error('E47C_WORKER_ACK_NOT_ACCEPTED');
 if(result.workerId!==expectedWorkerId)
  throw Error('E47C_WORKER_ACK_IDENTITY_MISMATCH');
 if(result.matched!==1)
  throw Error('E47C_WORKER_ACK_MATCH_COUNT_INVALID');
 if(result.persistedDeliveredWakes!==1)
  throw Error('E47C_WORKER_ACK_IMMEDIATE_DELIVERY_MISSING');
 if(!timing(result.timings?.ingestToMatchMs))
  throw Error('E47C_WORKER_ACK_INGEST_TIMING_INVALID');
 if(!Array.isArray(result.timings?.matchToWakeSamplesMs)||
    result.timings.matchToWakeSamplesMs.length!==1||
    !timing(result.timings.matchToWakeSamplesMs[0]))
  throw Error('E47C_WORKER_ACK_WAKE_TIMING_INVALID');
 return result;
}
export async function scheduleBoundedWorkerIngress({
 count,rate,maxInflight=4,workerIds,send,now,wait,maxCount=250,
 deliveryMode='immediate',
}={}){
 if(!Array.isArray(workerIds)||workerIds.length!==2||
    workerIds.some(x=>typeof x!=='string'||!x||x.length>128)||
    workerIds[0]===workerIds[1]||typeof send!=='function'||
    !['immediate','eventual'].includes(deliveryMode))
  throw Error('E47C_WORKER_INGRESS_CONFIG_INVALID');
 const job=await scheduleBoundedSourceOffers({
  count,rate,maxInflight,now,wait,maxCount,
  send:async i=>deliveryMode==='eventual'?
   validateDeferredWorkerAdmission(await send(i),workerIds[i%2]):
   validateWorkerIngestReceipt(await send(i),workerIds[i%2]),
 });
 const rows=job.rows.map((row,i)=>({
  ...row,workerId:workerIds[i%2],
  // Never persist URLs, bearer tokens or returned external effect payloads.
 }));
 return {...job,rows};
}
