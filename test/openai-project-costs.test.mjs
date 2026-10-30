import assert from 'node:assert/strict';
import test from 'node:test';
import {createOpenAIProjectCostReader}
  from '../scripts/validation/openai-project-costs.mjs';
const day=1761782400; // integer UTC midnight
test('admin-only project cost probe is redacted, 1-day aggregated and never per request',async()=>{
 let call;
 const fetchImpl=async(url,opt)=>{
   call={url,opt};
   return {ok:true,json:async()=>({
     object:'page',has_more:false,next_page:null,
     data:[{object:'bucket',start_time:day,end_time:day+86400,
       results:[{object:'organization.costs.result',project_id:'proj_test123',
         amount:{value:0.000043,currency:'usd'}}]}],
   })};
 };
 const reader=createOpenAIProjectCostReader({
   adminKey:'admin-test-secret',projectId:'proj_test123',fetchImpl,
 });
 const v=await reader.dailyCost({startTime:day,endTime:day+86400});
 assert.equal(v.projectCostMicros,43);
 assert.equal(v.projectCostUSD,0.000043);
 assert.equal(v.perRequestAttribution,false);
 assert.equal(v.finalInvoiceCertified,false);
 assert.equal(v.bucketWidth,'1d');
 assert.equal(new URL(call.url).hostname,'api.openai.com');
 assert.equal(call.opt.headers.authorization,'Bearer admin-test-secret');
 assert.equal(JSON.stringify(v).includes('admin-test-secret'),false);
 assert.equal(JSON.stringify(v).includes('proj_test123'),false);
 await assert.rejects(()=>reader.dailyCost({startTime:day+1,
   endTime:day+86400}),RangeError);
});
test('aggregated cost attribution refuses foreign project, pagination and currency',async()=>{
 const cases=[
   {has_more:true,data:[]},
   {has_more:false,data:[{start_time:day,end_time:day+86400,
     results:[{project_id:'proj_other999',amount:{value:0.04,currency:'usd'}}]}]},
   {has_more:false,data:[{start_time:day,end_time:day+86400,
     results:[{project_id:'proj_test123',amount:{value:0.04,currency:'eur'}}]}]},
 ];
 for(const item of cases){
   const reader=createOpenAIProjectCostReader({
     adminKey:'admin-test-secret',projectId:'proj_test123',
     fetchImpl:async()=>({ok:true,json:async()=>item}),
   });
   await assert.rejects(()=>reader.dailyCost({startTime:day,
     endTime:day+86400}),/EI_OPENAI_COST_/);
 }
});
