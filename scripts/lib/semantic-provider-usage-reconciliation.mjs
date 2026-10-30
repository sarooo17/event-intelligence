import {createHash} from 'node:crypto';

// Optional host-owned adapter boundary. This module never calls a provider,
// reads API keys, refunds budget or claims that response usage equals billing.
// The host MUST independently verify the provider-issued receipt.
const validId=x=>typeof x==='string'&&x.length>0&&x.length<=240;
const integer=x=>Number.isSafeInteger(x)&&x>=0&&x<=1_000_000_000;
const digest=x=>createHash('sha256').update(x).digest('hex');
const budgetError=(message,code)=>{
  const error=new Error(message);error.code=code;return error;
};

export function createPostgresSemanticUsageReconciler({
  store,budgetEpoch='1',verifyProviderReceipt,maxVerificationMs=2000,
}={}) {
  if(!store||typeof store.tx!=='function'||
     typeof store.lock!=='function'||typeof store.get!=='function'||
     typeof store.upsert!=='function'||!validId(store.scopeId)||
     !validId(budgetEpoch)||typeof verifyProviderReceipt!=='function') {
    throw new TypeError('Usage reconciliation needs scoped PG store and host verifier');
  }
  if(!Number.isSafeInteger(maxVerificationMs)||
     maxVerificationMs<10||maxVerificationMs>30000)
    throw new RangeError('Invalid provider receipt verification deadline');
  return Object.freeze({
    async record({
      namespace,reservationId,providerRequestId,
      inputTokens,outputTokens,cachedInputTokens=0,reasoningOutputTokens=0,
      reportedCostMicros=null,priceVersion=null,
    }={}) {
      if(!validId(namespace)||!validId(reservationId)||
         !validId(providerRequestId)||!integer(inputTokens)||
         !integer(outputTokens)||!integer(cachedInputTokens)||
         !integer(reasoningOutputTokens)||cachedInputTokens>inputTokens||
         reasoningOutputTokens>outputTokens||
         !Number.isSafeInteger(inputTokens+outputTokens)||
         inputTokens+outputTokens>1_000_000_000||
         (reportedCostMicros!==null&&!integer(reportedCostMicros))||
         (reportedCostMicros!==null&&!validId(priceVersion))||
         (priceVersion!==null&&!validId(priceVersion))) {
        throw new RangeError('Invalid normalized provider usage receipt');
      }
      const summary=Object.freeze({
        namespace,reservationId,providerRequestId,
        inputTokens,outputTokens,cachedInputTokens,reasoningOutputTokens,
        reportedCostMicros,priceVersion,
      });
      // A provider callback is untrusted until host verification succeeds.
      // A blocked callback must not hold PG locks or authorize reconciliation.
      const started=process.hrtime.bigint();
      let timer;
      let verified;
      try {
        verified=await Promise.race([
          Promise.resolve().then(()=>verifyProviderReceipt(summary)),
          new Promise(resolve=>{timer=setTimeout(()=>resolve(false),maxVerificationMs);}),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if(verified!==true||
         process.hrtime.bigint()-started>=BigInt(maxVerificationMs)*1000000n)
        throw budgetError('Host did not verify provider usage receipt',
          'EVENT_INTELLIGENCE_PROVIDER_USAGE_UNVERIFIED');
      const reservationDigest=digest(reservationId);
      const providerDigest=digest(providerRequestId);
      const reservationKey='reservation:'+JSON.stringify([
        namespace,budgetEpoch,reservationDigest]);
      const providerKey='provider:'+JSON.stringify([
        namespace,budgetEpoch,providerDigest]);
      return store.tx(async client=>{
        // Globally deterministic lock order prevents two workers reconciling
        // different provider IDs/reservations in opposite order.
        for(const key of [reservationKey,providerKey].sort())
          await store.lock(client,'semantic-usage-reconcile',key);
        const receipt=await store.get('semantic_budget_receipt',reservationKey,client);
        if(receipt?.contract!=='ei.semantic-reservation.v1'||
           receipt.reservationDigest!==reservationDigest||
           !integer(receipt.reservedTokens)||
           !integer(receipt.reservedCostMicros)) {
          throw budgetError('No durable reserved admission to reconcile',
            'EVENT_INTELLIGENCE_PROVIDER_USAGE_NO_RESERVATION');
        }
        const prior=await store.get('semantic_provider_usage',providerKey,client);
        const actualTokens=inputTokens+outputTokens;
        const tokenExceeded=actualTokens>receipt.reservedTokens;
        const costExceeded=reportedCostMicros!==null&&
          reportedCostMicros>receipt.reservedCostMicros;
        const result={
          contract:'ei.semantic-provider-usage.v1',
          reservationDigest,providerRequestDigest:providerDigest,
          inputTokens,outputTokens,cachedInputTokens,reasoningOutputTokens,
          ...(reportedCostMicros===null?{}:{reportedCostMicros,priceVersion}),
          withinReservedTokens:!tokenExceeded,
          withinReservedCost:reportedCostMicros===null?null:!costExceeded,
          // Response usage is not proof of provider billing or cancellation.
          billingConfirmed:false,
          status:tokenExceeded||costExceeded
            ?'usage_exceeds_reservation':'usage_observed_billing_unknown',
        };
        if(prior) {
          if(JSON.stringify(prior)!==JSON.stringify(result))
            throw budgetError('Provider request ID reused for conflicting usage',
              'EVENT_INTELLIGENCE_PROVIDER_USAGE_CONFLICT');
          return result; // exact duplicate is idempotent, not another charge
        }
        if(receipt.status!=='reserved_billing_unknown')
          throw budgetError('Reservation already reconciled with another provider request',
            'EVENT_INTELLIGENCE_PROVIDER_USAGE_CONFLICT');
        await store.upsert('semantic_provider_usage',providerKey,result,client);
        await store.upsert('semantic_budget_receipt',reservationKey,{
          ...receipt,status:result.status,providerRequestDigest:providerDigest,
          observedInputTokens:inputTokens,observedOutputTokens:outputTokens,
          billingConfirmed:false,
        },client);
        // Never refund unused worst-case quota. Timeout/retries may still bill
        // externally, so reservation counters stay exactly as charged.
        return result;
      });
    },
  });
}
