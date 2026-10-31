// Operator-only SDK v1 retention assertion. No source/audit/receipt pruning.
// A read-only integrity sampling helper, NOT atomic across independent calls,
// NOT a physical retention permission and NOT a provider completeness proof.
const integer=(x,min,max)=>Number.isSafeInteger(x)&&x>=min&&x<=max;
function refusal(code,message){
  const error=new Error(message);
  error.code=code;
  return error;
}
export async function verifyPostgresV1NoPruneRetention({
  store,maxOccurrences=10000,maxAuditRecords=10000,
  maxSources=1024,maxScanMs=5000,maxMatchRevisions=100,
  maxSourceBytes=16*1024*1024,maxAuditBytes=8*1024*1024,
  maxSourceRowBytes=131072,maxAuditRowBytes=131072,
  matchIds=[],wakeIds=[],
}={}){
  if(!store||typeof store.listMcpOccurrencesAfter!=='function'||
     typeof store.getMcpOccurrenceArchiveCheckpoint!=='function'||
     typeof store.inspectMcpSourceRetentionBarriers!=='function'||
     typeof store.getAuditCheckpoint!=='function'||
     typeof store.getBoundedInspectionMatch!=='function'||
     typeof store.getRecentTriggerMatchHistory!=='function'||
     typeof store.latestWake!=='function'||
     typeof store.getWakeDelivery!=='function'||
     typeof store.latestMcpEventSequence!=='function'||
     typeof store.auditLength!=='function'||
     !integer(maxOccurrences,1,10000)||
     !integer(maxAuditRecords,1,10000)||
     !integer(maxSources,1,16384)||
     !integer(maxScanMs,100,30000)||
     !integer(maxMatchRevisions,1,500)||
     !integer(maxSourceBytes,1024,64*1024*1024)||
     !integer(maxAuditBytes,1024,64*1024*1024)||
     !integer(maxSourceRowBytes,1024,1024*1024)||
     !integer(maxAuditRowBytes,1024,1024*1024)||
     !Array.isArray(matchIds)||matchIds.length>100||
     !Array.isArray(wakeIds)||wakeIds.length>100||
     [...matchIds,...wakeIds].some(id=>typeof id!=='string'||!id||
       id.length>240) ||
     new Set(matchIds).size!==matchIds.length||
     new Set(wakeIds).size!==wakeIds.length){
    throw refusal('EVENT_INTELLIGENCE_V1_RETENTION_POLICY_INVALID',
      'V1 no-prune audit requires bounded scope, sources, events and identities');
  }
  // These are READ-ONLY preflights. They may fail-closed under active writes:
  // a live host must retry/inspect rather than interpret mismatched snapshots
  // as missing events or treat a successful report as physical-delete permission.
  const inventory=await store.inspectMcpSourceRetentionBarriers({
    maxSources,maxScanMs,
  });
  if(inventory.scopeId!==store.scopeId||
     inventory.physicalSourcePruneAuthorized!==false||
     inventory.productionReplayFloorEstablished!==false){
    throw refusal('EVENT_INTELLIGENCE_V1_RETENTION_POLICY_UNSAFE',
      'Unverified source prune/replay authorization');
  }
  const [sourceTail,auditRows]=await Promise.all([
    store.latestMcpEventSequence({maxScanMs}),store.auditLength({maxScanMs}),
  ]);
  if(!integer(sourceTail,0,maxOccurrences)||
     !integer(auditRows,0,maxAuditRecords)){
    throw refusal('EVENT_INTELLIGENCE_V1_RETENTION_BUDGET_EXCEEDED',
      'V1 source/audit validation requires an explicitly bounded scope');
  }
  // Source reader verifies *all* history against dedup and persisted counter
  // even when a client normally asks only for an advanced cursor.
  const occurrences=await store.listMcpOccurrencesAfter(0,{
    maxScanMs,maxTotalBytes:maxSourceBytes,maxRowBytes:maxSourceRowBytes,
  });
  const sourceCheckpoint=await store.getMcpOccurrenceArchiveCheckpoint({
    maxOccurrences,maxScanMs,maxTotalBytes:maxSourceBytes,
    maxRowBytes:maxSourceRowBytes,
  });
  const auditCheckpoint=await store.getAuditCheckpoint({
    maxScanMs,maxTotalBytes:maxAuditBytes,maxRowBytes:maxAuditRowBytes,
  });
  if(occurrences.length!==sourceTail||
     sourceCheckpoint.endSequence!==sourceTail||
     inventory.sourceTailSequence!==sourceTail||
     auditCheckpoint.endSequence+1!==auditRows){
    throw refusal('EVENT_INTELLIGENCE_V1_RETENTION_SNAPSHOT_CHANGED',
      'Source/audit changed across non-atomic operator integrity reads');
  }
  const matchWitnesses=[];
  for(const id of matchIds){
    const window=await store.getRecentTriggerMatchHistory(id,{
      limit:maxMatchRevisions,maxRowBytes:65536,
      maxTotalBytes:1048576,maxScanMs:Math.min(maxScanMs,5000),
    });
    if(!window?.records?.length||window.hasMore){
      throw refusal('EVENT_INTELLIGENCE_V1_RETENTION_MATCH_HISTORY_INVALID',
        'Missing or truncated durable match provenance');
    }
    // The current authoritative match must ALSO use a bounded SQL
    // payload read. Never transfer its unbounded JSONB concurrently with
    // the already-bounded history window.
    const latest=window.records[window.records.length-1];
    const current=await store.getBoundedInspectionMatch({
      triggerId:latest.triggerId,version:latest.triggerVersion,
      matchId:id,maxRowBytes:65536,
      maxScanMs:Math.min(maxScanMs,5000),maxCandidates:1,
    });
    if(!current||JSON.stringify(latest)!==JSON.stringify(current)){
      throw refusal('EVENT_INTELLIGENCE_V1_RETENTION_MATCH_HISTORY_INVALID',
        'Missing latest durable match provenance');
    }
    matchWitnesses.push({id,status:current.status,
      revisions:window.records.length});
  }
  const wakeWitnesses=[];
  for(const id of wakeIds){
    const [delivery,latest]=await Promise.all([
      store.getWakeDelivery(id),store.latestWake(id),
    ]);
    if(!delivery||delivery.wakeId!==id||!latest||latest.wakeId!==id||
       delivery.status==='delivered'&&
       (typeof delivery.runtimeReceiptId!=='string'||
        !delivery.runtimeReceiptId)||
       !['pending','retry_pending','claimed','delivered','dead_letter']
         .includes(delivery.status)){
      throw refusal('EVENT_INTELLIGENCE_V1_RETENTION_RECEIPT_INVALID',
        'Missing, malformed or unreceipted durable wake delivery');
    }
    wakeWitnesses.push({id,status:delivery.status,
      receiptPresent:Boolean(delivery.runtimeReceiptId)});
  }
  return Object.freeze({
    schema:'event-intelligence.pg-no-prune-retention-v1',
    strategy:'preserve-all-source-audit-and-dedup',
    scopeId:store.scopeId,
    sourceTailSequence:sourceTail,
    sourceHeadHash:sourceCheckpoint.headHash,
    auditEndSequence:auditCheckpoint.endSequence,
    auditHeadHash:auditCheckpoint.headHash,
    matches:Object.freeze(matchWitnesses),
    wakes:Object.freeze(wakeWitnesses),
    // May contain an unresolved actual provider gap; cannot prove history
    // complete beyond what EI saw, nor authorize deleting any rows.
    sourceDeliveryGapsObserved:inventory.sources.some(x=>x.gapUnresolved),
    providerCompletenessCertified:false,
    externalArchiveCertified:false,
    sourcePruneAuthorized:false,
    auditPruneAuthorized:false,
    receiptPruneAuthorized:false,
    archiveBackedReplayFloorEstablished:false,
    atomicAcrossAllChecks:false,
    verifiedOnlyAgainstCurrentLocalRows:true,
  });
}
