#!/usr/bin/env node
// Separate read-only admin billing witness. Never give this key to the model
// runner and never claim a daily project aggregate is an invoice or a call.
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createOpenAIProjectCostReader} from './openai-project-costs.mjs';

const fail=code=>{const e=new Error(code);e.code=code;throw e;};
const digest=x=>createHash('sha256').update(x).digest('hex');

export function utcDayWindow(day,now=Date.now()){
  if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day))
    return fail('EI_COST_DAY_MUST_BE_ISO_DATE');
  const start=Date.parse(day+'T00:00:00.000Z');
  if(!Number.isFinite(start)||
     new Date(start).toISOString().slice(0,10)!==day)
    return fail('EI_COST_DAY_INVALID');
  const end=start+86400000;
  // Billing can settle after the requested day; never allow today/future.
  if(end>now) return fail('EI_COST_DAY_UNSETTLED');
  return Object.freeze({startTime:start/1000,endTime:end/1000});
}

export async function witnessProjectDailyCost({
  adminKey,projectId,day,fetchImpl,now=Date.now(),
}={}){
  if(typeof projectId!=='string'||projectId.length>128)
    return fail('EI_COST_PROJECT_INVALID');
  const window=utcDayWindow(day,now);
  const reader=createOpenAIProjectCostReader({
    adminKey,projectId,...(fetchImpl?{fetchImpl}:{}),
  });
  const measurement=await reader.dailyCost(window);
  return Object.freeze({
    contract:'ei.openai-project-cost-witness.v1',
    dayUTC:day,
    projectIdDigest:digest(projectId),
    measuredProjectCostMicros:measurement.projectCostMicros,
    measuredProjectCostUSD:measurement.projectCostUSD,
    providerReported:true,
    projectFiltered:measurement.projectFiltered,
    period:'one UTC day',
    // An isolated test project with one request is only operator-attested:
    // other activity, delayed costs, unrelated project billing, tax etc.
    // cannot be independently eliminated by this aggregate endpoint.
    isolatedProjectOperatorAttestationRequired:true,
    perRequestAttribution:false,
    independentInvoiceConfirmed:false,
    remoteCancellationCertified:false,
    finalBillingSettlementCertified:false,
    requiresManualReservationLink:true,
  });
}

async function main(){
  const env=process.env;
  if(env.EI_CONFIRM_ADMIN_COST_WITNESS!=='YES'||
     !env.OPENAI_ADMIN_KEY||
     !env.EI_OPENAI_PROJECT_ID||
     !env.EI_OPENAI_COST_DAY_UTC)
    return fail('EI_ADMIN_COST_WITNESS_DISABLED_OR_MISSING_KEYS');
  const result=await witnessProjectDailyCost({
    adminKey:env.OPENAI_ADMIN_KEY,
    projectId:env.EI_OPENAI_PROJECT_ID,
    day:env.EI_OPENAI_COST_DAY_UTC,
  });
  // No plaintext keys, project ID, API response body or request IDs.
  process.stdout.write(JSON.stringify(result)+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  main().catch(err=>{
    console.error(err?.code??'EI_ADMIN_COST_WITNESS_FAILED');
    process.exitCode=1;
  });
