import { createHash } from 'node:crypto';

// Optional PG16-backed, host-owned cost reservation for semantic evaluator calls.
// No model SDK, credentials, agent process or downstream action belongs here.
// The host must provide conservative per-call UPPER BOUNDS for tokens and cost.
const integer=(v,max=1000000000)=>Number.isSafeInteger(v)&&v>=0&&v<=max;
const validId=x=>typeof x==='string'&&x.length>0&&x.length<=240;
const digest=x=>createHash('sha256').update(x).digest('hex');
function limits(input){
  const fields=['maxTriggerCalls','maxTriggerTokens','maxTriggerCostMicros',
    'maxBatchCalls','maxBatchTokens','maxBatchCostMicros'];
  if(!input || fields.some(k=>!integer(input[k]))) {
    throw new RangeError('Semantic admission requires bounded nonnegative budgets');
  }
  const windows=['maxTriggerWindowMs','maxBatchWindowMs'];
  if(windows.some(k=>input[k]!=null &&
     (!Number.isSafeInteger(input[k])||input[k]<10||input[k]>86400000))) {
    throw new RangeError('Invalid PG semantic admission time window');
  }
  return {
    ...Object.fromEntries(fields.map(k=>[k,input[k]])),
    maxTriggerWindowMs:input.maxTriggerWindowMs ?? null,
    maxBatchWindowMs:input.maxBatchWindowMs ?? null,
  };
}
export function createPostgresSemanticAdmission({
  store,batchId,budgetEpoch='1',budget,estimate,maxEstimateMs=2000,
}={}){
  if(!store || typeof store.tx!=='function' ||
     typeof store.lock!=='function' ||
     typeof store.get!=='function' ||
     typeof store.upsert!=='function' ||
     !validId(store.scopeId) || !validId(batchId) ||
     !validId(budgetEpoch) || typeof estimate!=='function') {
    throw new TypeError('Requires a scoped PG16 store, stable host-owned batch and trusted cost estimator');
  }
  if(!Number.isSafeInteger(maxEstimateMs) || maxEstimateMs<10 || maxEstimateMs>30000) {
    throw new RangeError('maxEstimateMs must be an integer from 10 to 30000');
  }
  const policy=limits(budget);
  // Every worker sharing one policy epoch MUST enforce the same quotas.
  // Without durable pinning, a rolling deploy could silently increase
  // maxTriggerCalls / cost ceilings while reusing the same counters.
  const policyFingerprint=JSON.stringify(policy);
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
         !integer(request.instructionBytes,16384) ||
         (request.reservationId!==undefined &&
           !validId(request.reservationId))) return false;
      // The host owns the estimator and must supply worst-case billable
      // upper bounds, NOT just a best-effort estimated average.
      // The host estimator runs before reservation. A stuck estimator must
      // deny, not leave the evaluation waiting indefinitely or admit at zero cost.
      const estimatorStartedNs=process.hrtime.bigint();
      let timer;
      let estimateResult;
      try {
        estimateResult=await Promise.race([
          Promise.resolve().then(()=>estimate(Object.freeze({
            evaluatorIdentity:request.evaluatorIdentity,
            inputBytes:request.inputBytes,
            instructionBytes:request.instructionBytes,
          }))),
          new Promise(resolve=>{
            timer=setTimeout(()=>resolve(null),maxEstimateMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      // Promise.race alone is insufficient: a synchronous callback may
      // block the event loop beyond the deadline and resolve before its
      // overdue timeout callback can execute. Reject by monotonic elapsed time.
      if(process.hrtime.bigint()-estimatorStartedNs >= BigInt(maxEstimateMs)*1000000n) {
        return false;
      }
      if(!estimateResult || !integer(estimateResult.tokens) ||
         !integer(estimateResult.costMicros)) return false;
      const {tokens,costMicros}=estimateResult;
      const prefix=JSON.stringify([request.namespace,budgetEpoch]);
      const triggerKey='trigger:'+prefix;
      const batchKey='batch:'+JSON.stringify([request.namespace,budgetEpoch,batchId]);
      // Opt-in per-call identity prevents retries from spending one reservation
      // on multiple provider calls. Persist only a digest of host IDs, not
      // an application payload or external provider credential.
      const receiptKey=request.reservationId===undefined ? null :
        'reservation:'+JSON.stringify([request.namespace,budgetEpoch,
          digest(request.reservationId)]);
      // Locking triggerKey serializes every worker's reservations in the
      // SAME scoped PG store across distinct pg Pools and processes.
      return store.tx(async client=>{
        await store.lock(client,'semantic-budget',triggerKey);
        const trigger=await store.get('semantic_budget',triggerKey,client);
        const batch=await store.get('semantic_budget',batchKey,client);
        // The trigger lock also serializes receipt lookups across separate
        // pg Pools/workers and host restarts. A duplicate ALWAYS denies,
        // even if it changes batchId or repeats after a remote timeout.
        if(receiptKey!==null){
          const existing=await store.get('semantic_budget_receipt',receiptKey,client);
          if(existing!==null && existing!==undefined) return false;
        }
        if(!check(trigger)||!check(batch)){
          throw new Error('Corrupt semantic budget ledger: fail closed');
        }
        if((trigger && trigger.policyFingerprint!==policyFingerprint) ||
           (batch && batch.policyFingerprint!==policyFingerprint)) {
          const error=new Error('Semantic budget policy conflict: choose a new host epoch');
          error.code='EVENT_INTELLIGENCE_SEMANTIC_BUDGET_POLICY_CONFLICT';
          throw error;
        }
        // Authoritative database clock: no worker-local time or restart can
        // extend a trigger/batch admission window. The same lock protects
        // the first start time and every later budget reservation.
        const clock=await client.query(
          "SELECT floor(extract(epoch from clock_timestamp())*1000)::bigint AS ms");
        const nowMs=Number(clock.rows[0]?.ms);
        if(!Number.isSafeInteger(nowMs))throw Error('Invalid PG budget clock');
        const windowed=(row,windowMs)=>{
          if(row && row.deadlineAtMs != null &&
             !Number.isSafeInteger(row.deadlineAtMs)) {
            throw new Error('Corrupt semantic budget window: fail closed');
          }
          if(row && windowMs !== null && row.deadlineAtMs == null) {
            throw new Error('Missing persisted budget window: select a new host epoch');
          }
          const deadlineAtMs=row?.deadlineAtMs ??
            (windowMs===null?null:nowMs+windowMs);
          if(deadlineAtMs !== null &&
             (!Number.isSafeInteger(deadlineAtMs) || nowMs>=deadlineAtMs)) {
            return null;
          }
          return {...(row??{calls:0,tokens:0,costMicros:0}),deadlineAtMs};
        };
        const a=windowed(trigger,policy.maxTriggerWindowMs);
        const z=windowed(batch,policy.maxBatchWindowMs);
        if(!a||!z)return false;
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
          policyFingerprint,
          ...(old.deadlineAtMs===null ? {} : {deadlineAtMs:old.deadlineAtMs}),
        });
        await store.upsert('semantic_budget',triggerKey,next(a),client);
        await store.upsert('semantic_budget',batchKey,next(z),client);
        if(receiptKey!==null){
          await store.upsert('semantic_budget_receipt',receiptKey,{
            contract:'ei.semantic-reservation.v1',
            reservationDigest:digest(request.reservationId),
            namespaceDigest:digest(request.namespace),
            batchDigest:digest(batchId),
            evaluatorDigest:digest(request.evaluatorIdentity),
            candidateDigest:digest(request.candidateSignature),
            budgetEpochDigest:digest(budgetEpoch),
            reservedTokens:tokens,
            reservedCostMicros:costMicros,
            status:'reserved_billing_unknown',
            admittedAtMs:nowMs,
            policyFingerprint,
          },client);
        }
        return true;
      });
    },
  });
}
