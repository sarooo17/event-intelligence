// Optional PG16-backed, host-owned cost reservation for semantic evaluator calls.
// No model SDK, credentials, agent process or downstream action belongs here.
// The host must provide conservative per-call UPPER BOUNDS for tokens and cost.
const integer=(v,max=1000000000)=>Number.isSafeInteger(v)&&v>=0&&v<=max;
const validId=x=>typeof x==='string'&&x.length>0&&x.length<=240;
function limits(input){
  const fields=['maxTriggerCalls','maxTriggerTokens','maxTriggerCostMicros',
    'maxBatchCalls','maxBatchTokens','maxBatchCostMicros'];
  if(!input || fields.some(k=>!integer(input[k]))) {
    throw new RangeError('Semantic admission requires bounded nonnegative budgets');
  }
  return Object.fromEntries(fields.map(k=>[k,input[k]]));
}
export function createPostgresSemanticAdmission({
  store,batchId,budgetEpoch='1',budget,estimate,
}={}){
  if(!store || typeof store.tx!=='function' ||
     typeof store.lock!=='function' ||
     typeof store.get!=='function' ||
     typeof store.upsert!=='function' ||
     !validId(store.scopeId) || !validId(batchId) ||
     !validId(budgetEpoch) || typeof estimate!=='function') {
    throw new TypeError('Requires a scoped PG16 store, stable host-owned batch and trusted cost estimator');
  }
  const policy=limits(budget);
  const check=row=>!row || ['calls','tokens','costMicros'].every(k=>
    integer(row[k]));
  return Object.freeze({
    async reserve(request){
      if(!request || !validId(request.namespace) ||
         !validId(request.nodeId) ||
         typeof request.candidateSignature!=='string' ||
         request.candidateSignature.length>8192 ||
         typeof request.evaluatorIdentity!=='string' ||
         request.evaluatorIdentity.length>240 ||
         !integer(request.inputBytes,131072) ||
         !integer(request.instructionBytes,16384)) return false;
      // The host owns the estimator and must supply worst-case billable
      // upper bounds, NOT just a best-effort estimated average.
      const estimateResult=await estimate(Object.freeze({
        evaluatorIdentity:request.evaluatorIdentity,
        inputBytes:request.inputBytes,
        instructionBytes:request.instructionBytes,
      }));
      if(!estimateResult || !integer(estimateResult.tokens) ||
         !integer(estimateResult.costMicros)) return false;
      const {tokens,costMicros}=estimateResult;
      const prefix=JSON.stringify([request.namespace,budgetEpoch]);
      const triggerKey='trigger:'+prefix;
      const batchKey='batch:'+JSON.stringify([request.namespace,budgetEpoch,batchId]);
      // Locking triggerKey serializes every worker's reservations in the
      // SAME scoped PG store across distinct pg Pools and processes.
      return store.tx(async client=>{
        await store.lock(client,'semantic-budget',triggerKey);
        const trigger=await store.get('semantic_budget',triggerKey,client);
        const batch=await store.get('semantic_budget',batchKey,client);
        if(!check(trigger)||!check(batch)){
          throw new Error('Corrupt semantic budget ledger: fail closed');
        }
        const a=trigger??{calls:0,tokens:0,costMicros:0};
        const z=batch??{calls:0,tokens:0,costMicros:0};
        const approve=(used,calls,tokensLimit,costLimit)=>
          used.calls+1<=calls &&
          used.tokens+tokens<=tokensLimit &&
          used.costMicros+costMicros<=costLimit;
        if(!approve(a,policy.maxTriggerCalls,
              policy.maxTriggerTokens,policy.maxTriggerCostMicros) ||
           !approve(z,policy.maxBatchCalls,
              policy.maxBatchTokens,policy.maxBatchCostMicros)) return false;
        const next=old=>({
          calls:old.calls+1,
          tokens:old.tokens+tokens,
          costMicros:old.costMicros+costMicros,
        });
        await store.upsert('semantic_budget',triggerKey,next(a),client);
        await store.upsert('semantic_budget',batchKey,next(z),client);
        return true;
      });
    },
  });
}
