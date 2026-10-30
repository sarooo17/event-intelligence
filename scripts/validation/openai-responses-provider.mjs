import {createHash} from 'node:crypto';
import {createPostgresSemanticAdmission} from '../lib/postgres-semantic-admission.mjs';
import {createPostgresSemanticUsageReconciler} from '../lib/semantic-provider-usage-reconciliation.mjs';

// Isolated VALIDATION adapter, not part of the EI engine or published SDK.
// HTTPS endpoint is fixed to prevent an untrusted host-config URL/SSRF.
const ROOT='https://api.openai.com/v1';
const identifier=x=>typeof x==='string'&&x.length>0&&x.length<=240;
const bounded=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const digest=x=>createHash('sha256').update(x).digest('hex');
function error(code){const e=new Error(code);e.code=code;return e;}
function normalized(response){
  const u=response?.usage;
  if(!u||!bounded(u.input_tokens,0,1000000000)||
     !bounded(u.output_tokens,0,1000000000)||
     !bounded(u.input_tokens+u.output_tokens,0,1000000000)||
     !bounded(u.input_tokens_details?.cached_tokens??0,0,u.input_tokens)||
     !bounded(u.output_tokens_details?.reasoning_tokens??0,0,u.output_tokens))
    return null;
  return {
    inputTokens:u.input_tokens,outputTokens:u.output_tokens,
    cachedInputTokens:u.input_tokens_details?.cached_tokens??0,
    reasoningOutputTokens:u.output_tokens_details?.reasoning_tokens??0,
  };
}
function sameUsage(a,b){
  return !!a&&!!b&&Object.keys(a).every(k=>a[k]===b[k]);
}
const validResponseId=x=>typeof x==='string'&&
  /^resp_[A-Za-z0-9_-]{6,180}$/.test(x);
const validModelResponse=(actual,requested)=>actual===requested||
  (typeof actual==='string'&&actual.startsWith(requested+'-')&&
    /^[A-Za-z0-9_.-]{1,120}$/.test(actual));

// Validation only: provider GET is an independent *API retrieval* of usage,
// NOT an independent billing ledger or proof of provider-side cancellation.
export function createOpenAIResponsesValidationTransport({
  apiKey,fetchImpl=fetch,requestTimeoutMs=15000,
}={}){
  if(!identifier(apiKey)||typeof fetchImpl!=='function'||
     !bounded(requestTimeoutMs,100,30000))
    throw new TypeError('OpenAI validation transport requires credentials and a bounded fetch');
  async function call(method,path,body){
    let res;
    try{
      res=await fetchImpl(ROOT+path,{
        method,headers:{
          authorization:'Bearer '+apiKey,
          'content-type':'application/json',
        },
        ...(body!==undefined?{body:JSON.stringify(body)}:{}),
        signal:AbortSignal.timeout(requestTimeoutMs),
        redirect:'error',
      });
    }catch{
      // A timed-out create may have been billed remotely. Never auto-retry.
      throw error('EI_OPENAI_REMOTE_OUTCOME_UNKNOWN');
    }
    if(!res?.ok){
      // Do not project provider text into logs or errors: it may contain
      // request details, prompts, credentials, or sensitive provider metadata.
      throw error('EI_OPENAI_HTTP_'+(Number.isSafeInteger(res?.status)?res.status:'ERROR'));
    }
    try{return await res.json();}
    catch{throw error('EI_OPENAI_RESPONSE_MALFORMED');}
  }
  return Object.freeze({
    async countInput(model,input){
      const body=await call('POST','/responses/input_tokens',{model,input});
      if(!bounded(body?.input_tokens,0,1000000))
        throw error('EI_OPENAI_INPUT_COUNT_INVALID');
      return body.input_tokens;
    },
    async create({model,input,maxOutputTokens,background=false}){
      const result=await call('POST','/responses',{
        model,input,max_output_tokens:maxOutputTokens,
        truncation:'disabled',store:true,
        background,
        tools:[], // never allow extra billable tools or external writes
      });
      if(!validResponseId(result?.id)||!validModelResponse(result.model,model)||
         result.max_output_tokens!==maxOutputTokens)
        throw error('EI_OPENAI_RESPONSE_ID_OR_POLICY_INVALID');
      return result;
    },
    async retrieve(id){
      if(!validResponseId(id))throw new TypeError('Untrusted response ID');
      return call('GET','/responses/'+encodeURIComponent(id));
    },
    async cancelBackground(id){
      if(!validResponseId(id))throw new TypeError('Untrusted response ID');
      // OpenAI explicitly supports cancellation only for background:true.
      return call('POST','/responses/'+encodeURIComponent(id)+'/cancel');
    },
  });
}

// Exactly one preflight, one durable reserve, one actual provider request.
// A lost/failed response keeps its durable reservation and billing=unknown.
export async function runOpenAIResponsesValidationCase({
  store,transport,namespace='ei-provider-validation@1',
  batchId,reservationId,budgetEpoch='provider-validation-1',
  model='gpt-4o-mini',input='Classify this ticket: urgent.',
  maxInputTokens=128,maxOutputTokens=32,
  reservedCostMicros=100000,
}={}){
  if(!store||typeof transport?.countInput!=='function'||
     typeof transport?.create!=='function'||
     typeof transport?.retrieve!=='function'||
     !identifier(namespace)||!identifier(batchId)||!identifier(reservationId)||
     !identifier(budgetEpoch)||
     model!=='gpt-4o-mini'||
     typeof input!=='string'||!input||Buffer.byteLength(input,'utf8')>1024||
     !bounded(maxInputTokens,1,256)||!bounded(maxOutputTokens,1,64)||
     !bounded(reservedCostMicros,1,100000))
    throw new TypeError('Invalid bounded live provider test options');

  // Input count is measured by the same provider and same model BEFORE
  // touching the durable admission ledger or sending a billable response.
  const inputCount=await transport.countInput(model,input);
  if(!bounded(inputCount,0,maxInputTokens))
    return {status:'input_preflight_refused',providerRequests:0};

  const allowance=inputCount+maxOutputTokens;
  const admission=createPostgresSemanticAdmission({
    store,batchId,budgetEpoch,
    budget:{
      maxTriggerCalls:1,maxTriggerTokens:allowance,
      maxTriggerCostMicros:reservedCostMicros,
      maxBatchCalls:1,maxBatchTokens:allowance,
      maxBatchCostMicros:reservedCostMicros,
    },
    estimate:async()=>({tokens:allowance,costMicros:reservedCostMicros}),
  });
  const allowed=await admission.reserve({
    namespace,reservationId,nodeId:'openai-validation-response',
    evaluatorIdentity:'openai/'+model,
    candidateSignature:digest(input),
    inputBytes:Buffer.byteLength(input,'utf8'),
    instructionBytes:0,
  });
  if(!allowed)
    return {status:'admission_denied',providerRequests:0};

  let response;
  try{
    response=await transport.create({model,input,maxOutputTokens});
  }catch{
    return {status:'remote_billing_unknown',providerRequests:1,
      reservationRetained:true};
  }
  const usage=normalized(response);
  if(response.status!=='completed'||!usage){
    return {status:'remote_usage_unknown',providerRequests:1,
      reservationRetained:true,responseIdDigest:digest(response.id)};
  }
  // A second provider GET must reproduce the exact model, status, output cap
  // and all reported usage counters. This is still NOT a final invoice.
  const reconciler=createPostgresSemanticUsageReconciler({
    store,budgetEpoch,maxVerificationMs:15000,
    verifyProviderReceipt:async received=>{
      const fresh=await transport.retrieve(response.id);
      return fresh.id===response.id && fresh.model===response.model &&
        fresh.status==='completed' &&
        fresh.max_output_tokens===maxOutputTokens &&
        sameUsage(normalized(fresh),usage) &&
        received.providerRequestId===response.id &&
        received.inputTokens===usage.inputTokens &&
        received.outputTokens===usage.outputTokens &&
        received.cachedInputTokens===usage.cachedInputTokens &&
        received.reasoningOutputTokens===usage.reasoningOutputTokens;
    },
  });
  try{
    const record=await reconciler.record({
      namespace,reservationId,providerRequestId:response.id,
      ...usage,reportedCostMicros:null,
    });
    return {
      status:record.status,providerRequests:1,
      responseIdDigest:digest(response.id),
      ...usage,
      withinReservedTokens:record.withinReservedTokens,
      billingConfirmed:false,reservationRetained:true,
    };
  }catch{
    // Provider may have billed despite failed verification or lost GET.
    return {status:'remote_reconciliation_unknown',providerRequests:1,
      responseIdDigest:digest(response.id),reservationRetained:true,
      billingConfirmed:false};
  }
}
