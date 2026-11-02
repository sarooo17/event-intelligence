import test from 'node:test';
import assert from 'node:assert/strict';
import {scheduleBoundedSourceOffers,rateFromTimeline} from
 '../scripts/validation/e47c-open-loop-pacing.mjs';

test('open loop issues offers without awaiting slow source acknowledgements',async()=>{
 const now=()=>performance.now();
 const observed=[];
 const result=await scheduleBoundedSourceOffers({
  count:10,rate:5,maxInflight:4,now,
  send:async index=>{
   observed.push({index,t:now()});
   await new Promise(r=>setTimeout(r,260));
   return {accepted:true,sequence:index+2};
  },
 });
 assert.equal(result.accepted,10);
 assert.equal(result.rejected,0);
 assert.equal(result.rows.length,10);
 assert.ok(result.peakInflight>=2,'source ACK must overlap');
 assert.ok(result.peakInflight<=4);
 assert.ok(result.offeredRate>3.5,'offered rate cannot depend on response duration');
 assert.ok(result.acceptedCompletionRate>2);
 assert.ok(observed[1].t-observed[0].t<250);
 assert.equal(result.allAccepted,true);
});
test('inflight pressure does not silently throttle or convert drops to success',async()=>{
 const r=await scheduleBoundedSourceOffers({
  count:10,rate:5,maxInflight:1,
  send:async()=>{await new Promise(r=>setTimeout(r,450));return {accepted:true};},
 });
 assert.ok(r.rejected>0);
 assert.equal(r.allAccepted,false);
 assert.ok(r.rows.some(x=>x.status==='backpressure-refused'));
 assert.equal(r.peakInflight,1);
});
test('provider failures are retained without leaking exception text',async()=>{
 let id=0;
 const r=await scheduleBoundedSourceOffers({
  count:10,rate:5,maxInflight:4,
  send:async()=>{if(id++===2)throw Error('secret bearer TOKEN-HERE');return {accepted:true};},
 });
 assert.equal(r.accepted,9);
 assert.equal(r.allAccepted,false);
 const failure=r.rows.find(x=>x.status==='failed');
 assert.equal(failure.errorCode,'E47C_SOURCE_SEND_FAILED');
 assert.ok(!JSON.stringify(r.rows).includes('TOKEN-HERE'));
});
test('no unbounded rate or concurrency and no false rate with zero clock movement',async()=>{
 for(const rate of [0,2,10,Infinity]){
  await assert.rejects(scheduleBoundedSourceOffers({count:10,rate,send:async()=>({accepted:true})}),
   /E47C_BAD_OPEN_LOOP_CONFIGURATION/);
 }
 await assert.rejects(scheduleBoundedSourceOffers({count:10,rate:5,maxInflight:100,
  send:async()=>({accepted:true})}),/E47C_BAD_OPEN_LOOP_CONFIGURATION/);
 assert.equal(rateFromTimeline([{offeredAtMs:3},{offeredAtMs:3}],'offeredAtMs'),null);
});
