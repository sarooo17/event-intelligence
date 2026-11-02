// Schedule fixed-rate source offers from a monotonic clock independently of
// per-append ACK latency. Finite, explicit backpressure: never invent a pass.
import {performance} from 'node:perf_hooks';

const finite=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
const round=n=>Math.round(n*1000)/1000;
export function rateFromTimeline(rows,field){
 if(!Array.isArray(rows)||rows.length<2)return null;
 const first=rows[0]?.[field],last=rows.at(-1)?.[field];
 if(!finite(first)||!finite(last)||last<=first)return null;
 return round((rows.length-1)*1000/(last-first));
}
export async function scheduleBoundedSourceOffers({
 count,rate,maxInflight=4,send,
 now=()=>performance.now(),
 wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
}={}){
 if(!Number.isSafeInteger(count)||count<2||count>250||
    ![1,5].includes(rate)||!Number.isSafeInteger(maxInflight)||
    maxInflight<1||maxInflight>8||typeof send!=='function'||
    typeof now!=='function'||typeof wait!=='function')
  throw Error('E47C_BAD_OPEN_LOOP_CONFIGURATION');
 const start=now();
 if(!finite(start))throw Error('E47C_BAD_MONOTONIC_CLOCK');
 const rows=Array(count),responses=Array(count);
 let inflight=0,peakInflight=0;
 const tasks=[];
 for(let i=0;i<count;i++){
  const scheduledAtMs=i*1000/rate;
  const remaining=start+scheduledAtMs-now();
  if(remaining>0)await wait(remaining);
  const offeredAtMs=now()-start;
  if(!finite(offeredAtMs))throw Error('E47C_BAD_MONOTONIC_CLOCK');
  const base={index:i,scheduledAtMs:round(scheduledAtMs),
   offeredAtMs:round(offeredAtMs),
   offerLatenessMs:round(Math.max(0,offeredAtMs-scheduledAtMs))};
  if(inflight>=maxInflight){
   rows[i]={...base,completedAtMs:round(offeredAtMs),
    status:'backpressure-refused'};
   continue;
  }
  inflight++;
  peakInflight=Math.max(peakInflight,inflight);
  const task=(async()=>{
   try{
    const result=await send(i);
    const completedAtMs=now()-start;
    if(!finite(completedAtMs)||completedAtMs<offeredAtMs)
     throw Error('E47C_BAD_MONOTONIC_CLOCK');
    if(result?.accepted!==true)
     throw Error('E47C_SOURCE_ACK_REJECTED');
    responses[i]=result;
    rows[i]={...base,completedAtMs:round(completedAtMs),status:'accepted'};
   }catch(e){
    const completedAtMs=now()-start;
    rows[i]={...base,
     completedAtMs:round(finite(completedAtMs)?completedAtMs:offeredAtMs),
     status:'failed',
     // Error code only, never propagate URLs/headers/tokens into artifacts.
     errorCode:/^E47C_[A-Z0-9_]+$/.test(e?.message??'')?
      e.message:'E47C_SOURCE_SEND_FAILED'};
   }finally{inflight--;}
  })();
  tasks.push(task);
 }
 await Promise.all(tasks);
 const offeredRate=rateFromTimeline(rows,'offeredAtMs');
 const accepted=rows.filter(row=>row?.status==='accepted');
 const completedRate=rateFromTimeline(accepted,'completedAtMs');
 return {rows,responses,peakInflight,
  offeredRate,acceptedCompletionRate:completedRate,
  allAccepted:accepted.length===count,
  accepted:accepted.length,
  rejected:count-accepted.length};
}
