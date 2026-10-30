// EI-maintained reference application adapter. It composes the *public*
// embedded package API. No model, chat loop, credentials, or native tool ABI.
// Host callbacks MUST implement their own persistent receipt/outbox and
// current authorization checks. The demo test's Map is not HA storage.
import {
  createEventIntelligence,
  createEventSourceRegistry,
} from 'mcp-event-intelligence/embedded';

function requiredFunction(value,name) {
  if(typeof value!=='function') throw new TypeError('headless host requires '+name+'()');
}
const denied=()=>Object.assign(new Error('Host job target unavailable or revoked'),{
  code:'HEADLESS_HOST_TARGET_DENIED',
});

export function createHeadlessJobRuntime({
  receiptNamespace,resolveLiveJob,readReceipt,enqueueAtomic,
}={}){
  if(typeof receiptNamespace!=='string'||!receiptNamespace.trim())
    throw new TypeError('headless host requires explicit receiptNamespace');
  for(const [name,fn] of Object.entries({resolveLiveJob,readReceipt,enqueueAtomic}))
    requiredFunction(fn,name);

  // The host is responsible for binding its authenticated job identity and
  // scope. Event data and model output cannot grant a job permission.
  // Receipt read is only an optimization: the host MUST atomically deduplicate
  // enqueueAtomic() using its own unique durable receipt key.
  return Object.freeze({
    receiptNamespace,
    async hasReceipt(receiptId){
      const row=await readReceipt(receiptId);
      if(row==null)return false;
      if(row.receiptId!==receiptId)throw new Error('HEADLESS_HOST_RECEIPT_MISMATCH');
      return true;
    },
    async resolveTarget(target,activation){
      if(target?.kind!=='job')return null;
      return await resolveLiveJob(target,activation);
    },
    async deliver({activation,receiptId}){
      // Host policy/revocation MUST be checked again INSIDE the atomic
      // outbox write. This preflight is not a substitute for its transaction.
      const current=await resolveLiveJob(activation.target,activation);
      if(current==null)throw denied();
      const row=await enqueueAtomic({receiptId,target:current,activation});
      if(row?.receiptId!==receiptId||row?.durable!==true)
        throw new Error('HEADLESS_HOST_DURABLE_RECEIPT_REQUIRED');
      return {runtimeReceiptId:receiptId,duplicate:row.duplicate===true};
    },
  });
}

export async function createHeadlessJobExample({
  dataDir,store,env={},receiptNamespace,
  listConnections,subscribeConnections,
  resolveLiveJob,readReceipt,enqueueAtomic,
}={}){
  requiredFunction(listConnections,'listConnections');
  if(subscribeConnections!==undefined)
    requiredFunction(subscribeConnections,'subscribeConnections');
  const runtime=createHeadlessJobRuntime({
    receiptNamespace,resolveLiveJob,readReceipt,enqueueAtomic,
  });
  const mcp=createEventSourceRegistry({
    list:listConnections,
    ...(subscribeConnections?{subscribe:subscribeConnections}:{}),
  });
  const integration=await createEventIntelligence({
    ...(dataDir?{dataDir}:{}),
    ...(store?{store}:{}),
    env,mcp,runtime,
  });
  return Object.freeze({
    integration,
    host:integration.host,
    close:()=>integration.close(),
  });
}
