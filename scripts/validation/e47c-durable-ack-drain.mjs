// E47-C first-party preflight: a successful /v1/events response may persist
// one match while host wake delivery completes asynchronously. This helper
// checks durable settlement separately; it does NOT silently admit dropped
// worker requests or turn synthetic first-party runs into production SLO.
import {performance} from 'node:perf_hooks';

const isFiniteTiming=value=>typeof value==='number'&&
 Number.isFinite(value)&&value>=0;
const fail=code=>{throw Object.assign(new Error(code),{code});};

export function validateDeferredWorkerAdmission(result,expectedWorkerId){
 if(!expectedWorkerId||typeof expectedWorkerId!=='string')
  fail('E47C_WORKER_ACK_CONFIG_INVALID');
 if(result?.accepted!==true)fail('E47C_WORKER_ACK_NOT_ACCEPTED');
 if(result.workerId!==expectedWorkerId)
  fail('E47C_WORKER_ACK_IDENTITY_MISMATCH');
 if(result.matched!==1)fail('E47C_WORKER_ACK_MATCH_COUNT_INVALID');
 if(![0,1].includes(result.persistedDeliveredWakes))
  fail('E47C_WORKER_ACK_DELIVERY_COUNT_INVALID');
 if(!isFiniteTiming(result.timings?.ingestToMatchMs))
  fail('E47C_WORKER_ACK_INGEST_TIMING_INVALID');
 if(!Array.isArray(result.timings?.matchToWakeSamplesMs)||
    result.timings.matchToWakeSamplesMs.length!==
     result.persistedDeliveredWakes||
    result.timings.matchToWakeSamplesMs.some(x=>!isFiniteTiming(x)))
  fail('E47C_WORKER_ACK_WAKE_TIMING_INVALID');
 // Delivery 0 means only that this immediate worker response does not
 // demonstrate host delivery. Full durable reconciliation remains mandatory.
 return result;
}

// A bounded read-only gate: the final per-event source/match/wake/host lineage
// must STILL be verified by the separate code path before reporting a pass.
// Host receipt counts are not equivalent to one-to-one event correctness.
export async function waitForDurableReceiptCount({
 expectedCount,maxExpectedCount=250,maxWaitMs=30000,pollMs=500,readCounts,
 now=()=>performance.now(),
 wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))
}={}){
 if(!Number.isSafeInteger(maxExpectedCount)||maxExpectedCount<10||
    maxExpectedCount>1000||!Number.isSafeInteger(expectedCount)||
    expectedCount<10||expectedCount>maxExpectedCount||
    !Number.isSafeInteger(maxWaitMs)||maxWaitMs<1000||maxWaitMs>120000||
    !Number.isSafeInteger(pollMs)||pollMs<100||pollMs>5000||
    typeof readCounts!=='function'||typeof now!=='function'||
    typeof wait!=='function')
  fail('E47C_DURABLE_DRAIN_CONFIG_INVALID');
 const start=now();
 if(!isFiniteTiming(start))fail('E47C_DURABLE_DRAIN_CLOCK_INVALID');
 let polls=0;
 for(;;){
  const beforeRead=now()-start;
  if(!isFiniteTiming(beforeRead))fail('E47C_DURABLE_DRAIN_CLOCK_INVALID');
  if(beforeRead>=maxWaitMs)fail('E47C_DURABLE_DRAIN_TIMEOUT');
  // Callers can scope DB statement_timeout to the remaining budget.
  const sample=await readCounts({
   remainingMs:Math.max(1,Math.floor(maxWaitMs-beforeRead))
  });
  polls++;
  const receipts=sample?.receipts,uniqueWakes=sample?.uniqueWakes,
   uniqueReceipts=sample?.uniqueReceipts,delivered=sample?.delivered;
  if(!Number.isSafeInteger(receipts)||!Number.isSafeInteger(uniqueWakes)||
     !Number.isSafeInteger(uniqueReceipts)||!Number.isSafeInteger(delivered)||
     receipts<0||uniqueWakes<0||uniqueReceipts<0||delivered<0||
     receipts>expectedCount||uniqueWakes>expectedCount||
     uniqueReceipts>expectedCount||delivered>receipts||
     receipts!==uniqueWakes||receipts!==uniqueReceipts)
   fail('E47C_DURABLE_DRAIN_COUNT_MISMATCH');
  const elapsed=now()-start;
  if(!isFiniteTiming(elapsed))fail('E47C_DURABLE_DRAIN_CLOCK_INVALID');
  // A late query must never turn a timed-out campaign into a pass.
  if(elapsed>=maxWaitMs)fail('E47C_DURABLE_DRAIN_TIMEOUT');
  if(receipts===expectedCount&&delivered===expectedCount)
   return Object.freeze({
    settledCount:receipts,durableDelivered:delivered,polls,
    drainElapsedMs:Math.round(elapsed*1000)/1000,
    requirePerEventLineage:true,productionSloCertified:false
   });
  await wait(Math.min(pollMs,maxWaitMs-elapsed));
 }
}
