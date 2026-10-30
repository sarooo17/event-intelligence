// Optional, read-only organizational BILLING evidence. Keep the admin key
// completely separate from the API key used for model requests.
const validId=x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{6,128}$/.test(x);
export function createOpenAIProjectCostReader({
  adminKey,projectId,fetchImpl=fetch,timeoutMs=10000,
}={}){
  if(typeof adminKey!=='string'||!adminKey||!validId(projectId)||
     typeof fetchImpl!=='function'||
     !Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000)
    throw new TypeError('Cost reader requires an admin key, fixed project, bounded fetch');
  return Object.freeze({
    async dailyCost({startTime,endTime}={}){
      if(!Number.isSafeInteger(startTime)||!Number.isSafeInteger(endTime)||
         startTime<=0||startTime%86400!==0||endTime%86400!==0||
         endTime<=startTime||endTime-startTime>7*86400)
        throw new RangeError('Only bounded UTC whole-day cost windows allowed');
      const q=new URLSearchParams();
      q.set('start_time',String(startTime));
      q.set('end_time',String(endTime));
      q.set('bucket_width','1d');
      q.append('project_ids[]',projectId);
      q.append('group_by[]','project_id');
      let response;
      try{
        response=await fetchImpl(
          'https://api.openai.com/v1/organization/costs?'+q.toString(),{
            method:'GET',
            headers:{authorization:'Bearer '+adminKey,'content-type':'application/json'},
            redirect:'error',signal:AbortSignal.timeout(timeoutMs),
          });
      }catch{throw new Error('EI_OPENAI_COST_READ_UNAVAILABLE');}
      if(!response?.ok)throw new Error('EI_OPENAI_COST_HTTP_'+response?.status);
      let payload;
      try{payload=await response.json();}catch{
        throw new Error('EI_OPENAI_COST_RESPONSE_MALFORMED');
      }
      if(payload?.has_more!==false||!Array.isArray(payload.data)||
         payload.data.length<1||payload.data.length>7)
        throw new Error('EI_OPENAI_COST_PAGE_INCOMPLETE');
      let totalMicros=0;
      for(const day of payload.data){
        if(!Number.isSafeInteger(day.start_time)||!Number.isSafeInteger(day.end_time)||
           day.start_time<startTime||day.end_time>endTime||
           day.end_time-day.start_time!==86400||
           !Array.isArray(day.results)||day.results.length>1000)
          throw new Error('EI_OPENAI_COST_BUCKET_INVALID');
        for(const r of day.results){
          const dollars=r.amount?.value;
          if(r.project_id!==projectId||r.amount?.currency!=='usd'||
             !Number.isFinite(dollars)||dollars<0||
             dollars>100000||!Number.isSafeInteger(Math.round(dollars*1000000)))
            throw new Error('EI_OPENAI_COST_PROJECT_OR_CURRENCY_MISMATCH');
          totalMicros+=Math.round(dollars*1000000);
          if(!Number.isSafeInteger(totalMicros))
            throw new Error('EI_OPENAI_COST_OVERFLOW');
        }
      }
      return {
        contract:'ei.openai-daily-project-cost.v1',
        projectCostUSD:Math.round(totalMicros)/1e6,
        projectCostMicros:totalMicros,
        bucketWidth:'1d',
        providerReported:true,projectFiltered:true,
        perRequestAttribution:false,
        finalInvoiceCertified:false,
        eventualConsistencyUnknown:true,
        startTime,endTime,
      };
    },
  });
}
