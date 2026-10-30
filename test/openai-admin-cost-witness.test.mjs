import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {utcDayWindow,witnessProjectDailyCost}
  from '../scripts/validation/run-openai-admin-cost-witness.mjs';

const day='2026-10-25';
const start=Date.parse(day+'T00:00:00Z')/1000;
const now=Date.parse('2026-10-30T20:00:00Z');

test('live read-only project cost witness redacts credentials and does not certify per-response billing',async()=>{
  const requests=[];
  const fetchImpl=async(url,options)=>{
    requests.push({url,options});
    return {ok:true,json:async()=>({
      has_more:false,
      data:[{start_time:start,end_time:start+86400,
        results:[{project_id:'proj_test123',
          amount:{value:0.000053,currency:'usd'}}]}],
    })};
  };
  const output=await witnessProjectDailyCost({
    adminKey:'test-private-admin-key',projectId:'proj_test123',
    day,now,fetchImpl,
  });
  assert.equal(output.measuredProjectCostMicros,53);
  assert.equal(output.measuredProjectCostUSD,0.000053);
  assert.equal(output.projectFiltered,true);
  assert.equal(output.perRequestAttribution,false);
  assert.equal(output.independentInvoiceConfirmed,false);
  assert.equal(output.remoteCancellationCertified,false);
  assert.equal(output.isolatedProjectOperatorAttestationRequired,true);
  assert.equal(output.requiresManualReservationLink,true);
  const serialized=JSON.stringify(output);
  assert(!serialized.includes('test-private-admin-key'));
  assert(!serialized.includes('proj_test123'));
  assert.equal(requests.length,1);
  assert.equal(new URL(requests[0].url).hostname,'api.openai.com');
  assert.equal(requests[0].options.headers.authorization,'Bearer test-private-admin-key');
  assert.deepEqual(utcDayWindow(day,now),{
    startTime:start,endTime:start+86400,
  });
});
test('admin witness rejects wrong dates, unsettled days, foreign projects and pagination',async()=>{
  for(const date of ['2026-02-30','2026-10-30','bad','2026-2-03']){
    assert.throws(()=>utcDayWindow(date,now),/EI_COST_/);
  }
  const cases=[
    {has_more:true,data:[]},
    {has_more:false,data:[{start_time:start,end_time:start+86400,
      results:[{project_id:'proj_foreign',amount:{value:1,currency:'usd'}}]}]},
    {has_more:false,data:[{start_time:start,end_time:start+86400,
      results:[{project_id:'proj_test123',amount:{value:1,currency:'eur'}}]}]},
  ];
  for(const response of cases){
    await assert.rejects(()=>witnessProjectDailyCost({
      adminKey:'test-key',projectId:'proj_test123',day,now,
      fetchImpl:async()=>({ok:true,json:async()=>response}),
    }),/EI_OPENAI_COST_/);
  }
});
test('admin witness CLI without explicit opt-in cannot contact provider',()=>{
  const file=fileURLToPath(new URL(
    '../scripts/validation/run-openai-admin-cost-witness.mjs',import.meta.url));
  assert.throws(()=>execFileSync(process.execPath,[file],{
    env:{PATH:process.env.PATH,EI_CONFIRM_ADMIN_COST_WITNESS:'NO'},
    encoding:'utf8',timeout:8000,stdio:['ignore','pipe','pipe'],
  }),error=>
    error.status===1&&!error.stdout.includes('private'));
});
