// Strict, **read-only** #317 deployment inventory check. This tool cannot
// inspect live Railway variable values, trust a host assertion as independent,
// grant authority, prune tombstones or issue security certification.
const sha=/^[a-f0-9]{40}$/;
const safeName=x=>typeof x==='string'&&x.length>0&&x.length<=100&&
  /^[a-zA-Z0-9._-]+$/.test(x);
const deny=(code,message)=>Object.freeze({code,message});
export function assessDeployedHostPreflight(input){
  const failures=[];
  const workers=Array.isArray(input?.workers)?input.workers:[];
  if(!sha.test(input?.sourceCommit??''))failures.push(deny(
    'SOURCE_SHA_NOT_PINNED','Operator must identify exact deployed source SHA'));
  if(!safeName(input?.environment)||!safeName(input?.project))
    failures.push(deny('TARGET_UNSPECIFIED',
      'Operator must identify one project and environment without secrets'));
  if(workers.length<2||workers.length>32)
    failures.push(deny('WORKER_COUNT_UNPROVEN',
      'At least two and at most 32 independently running worker instances required'));
  const seen=new Set();
  for(let i=0;i<workers.length;i++){
    const worker=workers[i],label='worker-'+(i+1);
    if(!safeName(worker?.serviceName)||seen.has(worker.serviceName)){
      failures.push(deny('INVALID_WORKER_ID',
        label+' missing/duplicate public service name'));
      continue;
    }
    seen.add(worker.serviceName);
    if(!Array.isArray(worker.variableNames)||
       worker.variableNames.some(x=>typeof x!=='string')||
       new Set(worker.variableNames).size!==worker.variableNames.length){
      failures.push(deny('INVALID_REDACTED_INVENTORY',
        label+' requires only unique environment variable NAMES'));
      continue;
    }
    if(!worker.variableNames.includes('EVENT_INTELLIGENCE_REQUIRE_SHARED_STORE')){
      failures.push(deny('STRICT_SHARED_STORE_ENV_MISSING',
        label+' does not expose explicit strict-mode variable name'));
    }
    if(worker.runtimeEvidence?.sourceCommit!==input.sourceCommit||
       worker.runtimeEvidence?.requireMcpSessionFence!==true||
       worker.runtimeEvidence?.strictSharedStoreEnabled!==true){
      failures.push(deny('RUNTIME_FENCE_NOT_ATTESTED',
        label+' lacks source-pinned proof of strict PG session fence'));
    }
    if(worker.runtimeEvidence?.mixedLegacyWritersAbsent!==true){
      failures.push(deny('LEGACY_WRITER_EXCLUSION_UNVERIFIED',
        label+' does not prove all legacy/unfenced writers excluded'));
    }
    const witnesses=worker.runtimeEvidence?.connectionEpochWitnesses;
    if(!Array.isArray(witnesses)||!witnesses.length||
       new Set(witnesses.map(v=>v?.sourceId)).size!==witnesses.length||
       witnesses.some(v=>
         !safeName(v?.sourceId)||v.hostOwned!==true||
         typeof v.epochCommitmentSha256!=='string'||
         !/^[a-f0-9]{64}$/.test(v.epochCommitmentSha256))){
      failures.push(deny('HOST_EPOCH_WITNESS_MISSING',
        label+' lacks nonsecret host-owned authority-epoch commitments'));
    }
  }
  if(input?.postgres?.primaryTopology!=='ha-failover-tested')
    failures.push(deny('PG_PRIMARY_HA_NOT_MEASURED',
      'Single PG instance/undeclared failover cannot prove deployment RPO/RTO'));
  if(input?.host?.separatelyOperated!==true||
     input?.host?.maintainerDifferentFromEi!==true)
    failures.push(deny('INDEPENDENT_HOST_UNPROVEN',
      'Separately operated/maintained host not witnessed'));
  const requiredHostProbes=['postWakeReauthorization','revocationWhileQueued',
    'durableEffectReceipt','tenantQuota','compressedBodyLimit',
    'requestTimeout','policyCancellation'];
  for(const probe of requiredHostProbes){
    const row=input?.host?.probes?.[probe];
    if(row?.passed!==true||!sha.test(row.sourceCommit??'')||
       typeof row.redactedArtifactSha256!=='string'||
       !/^[a-f0-9]{64}$/.test(row.redactedArtifactSha256)){
      failures.push(deny('HOST_PROBE_UNVERIFIED',
        probe+' lacks pinned source and artifact-backed host witness'));
    }
  }
  if(input?.independentReview?.completed!==true||
     input?.independentReview?.coversTwelveBoundaries!==true||
     input.independentReview.sourceCommit!==input.sourceCommit||
     typeof input.independentReview.redactedReportDigest!=='string'||
     !/^[a-f0-9]{64}$/.test(input.independentReview.redactedReportDigest)){
    failures.push(deny('INDEPENDENT_HUMAN_REVIEW_PENDING',
      'Exact deployed-source, 12-boundary independent reviewer report missing'));
  }
  // This is a static self-supplied inventory only. Even when all items
  // look complete, NO code-only self-attestation certifies a real host.
  return Object.freeze({
    schema:'event-intelligence.deployed-host-preflight.v1',
    status:failures.length?'blocked':'operator-evidence-ready-for-independent-verification',
    inventoryOnly:true,
    deploymentCertified:false,
    externalSecuritySignedOff:false,
    irreversibleChangesPerformed:false,
    workerCount:workers.length,
    failures:Object.freeze(failures),
  });
}
