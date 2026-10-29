import { createHash, createPublicKey, verify } from 'node:crypto';

const MAX_BYTES=8*1024*1024;
const MAX_EVENTS=100000;
const NAME=/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const SHA=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const validName=value=>typeof value==='string'&&NAME.test(value);
const REFUSED='EI_INDEPENDENT_SLO_EVIDENCE_REFUSED';
const fail=code=>{const error=new Error(REFUSED+':'+code);error.code=REFUSED;throw error;};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const asTime=s=>typeof s==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(s) && Number.isFinite(Date.parse(s))?Date.parse(s):NaN;
function authenticatedFixture(input,expectedKeyId,publicKeyPem) {
  if (!Buffer.isBuffer(input?.bytes) || input.bytes.length<2 || input.bytes.length>MAX_BYTES ||
      typeof input.signature!=='string' || !/^[A-Za-z0-9+/]{86}==$/.test(input.signature) ||
      typeof input.keyId!=='string'||input.keyId!==expectedKeyId)fail('MISSING_SIGNED_BYTES');
  const snapshot=Buffer.from(input.bytes);
  let parsed;
  let normalizedKey;
  try {
    parsed=JSON.parse(snapshot.toString('utf8'));
    // No alternate encoding, whitespace or ambiguous duplicate JSON object members.
    if(Buffer.compare(Buffer.from(JSON.stringify(parsed)),snapshot)!==0)fail('NONCANONICAL_SIGNED_JSON');
    const key=createPublicKey(publicKeyPem);
    if(key.asymmetricKeyType!=='ed25519' ||
        !verify(null,snapshot,key,Buffer.from(input.signature,'base64')))fail('SIGNATURE_MISMATCH');
    normalizedKey=Buffer.from(key.export({type:'spki',format:'der'}));
  }catch(error){if(error?.code===REFUSED)throw error;fail('INVALID_SIGNED_FIXTURE');}
  return {body:parsed,sha256:sha(snapshot),keySha256:sha(normalizedKey)};
}
function uniqueMap(records,field) {
  if(!Array.isArray(records)||records.length<1000||records.length>MAX_EVENTS)fail('INVALID_SAMPLE_COUNT');
  const out=new Map();
  for(const record of records) {
    if(!record||!validName(record[field])||out.has(record[field]))fail('MISSING_OR_DUPLICATE_ID');
    out.set(record[field],record);
  }
  return out;
}
const finiteRate=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1e9;
function p99(values) {
  if(values.length<1000||values.some(x=>!finiteRate(x)))fail('INVALID_LATENCY_SERIES');
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.ceil(sorted.length*.99)-1];
}

/**
 * Verify two separately signed ORIGINAL raw evidence documents from a real
 * provider and real host against EI's durable reconciliation snapshot.
 * Never self-certify process separation or production SLO: signer ownership,
 * identity, resource isolation, public artifact provenance and clock source
 * are outside this verifier and require independent review.
 */
export function assessIndependentProviderHostEvidence({
  provider,host,expectedProviderKeyId,expectedHostKeyId,
  trustedProviderPublicKeyPem,trustedHostPublicKeyPem,
  expectedProviderId,expectedHostId,ei,preRegisteredSloBudgets,
}={}) {
  if(!validName(expectedProviderId)||!validName(expectedHostId) ||
      expectedProviderId===expectedHostId||
      !validName(expectedProviderKeyId)||!validName(expectedHostKeyId)||
      !ei || !preRegisteredSloBudgets ||
      typeof trustedProviderPublicKeyPem!=='string'||typeof trustedHostPublicKeyPem!=='string')fail('MISSING_INDEPENDENT_TRUST_ROOT');
  const p=authenticatedFixture(provider,expectedProviderKeyId,trustedProviderPublicKeyPem);
  const h=authenticatedFixture(host,expectedHostKeyId,trustedHostPublicKeyPem);
  if(p.keySha256===h.keySha256)fail('SIGNERS_SHARE_KEY');
  if(p.body?.schema!=='event-intelligence.provider-observations.v1' ||
      h.body?.schema!=='event-intelligence.host-observations.v1' ||
      p.body.providerId!==expectedProviderId ||
      h.body.hostId!==expectedHostId ||
      !validName(p.body.workloadId) || p.body.workloadId!==h.body.workloadId ||
      ei.workloadId!==p.body.workloadId)fail('SIGNED_IDENTITY_MISMATCH');

  const started=asTime(p.body.startedAt);
  const finished=asTime(p.body.finishedAt);
  const registered=asTime(preRegisteredSloBudgets.registeredAt);
  if(!Number.isFinite(started)||!Number.isFinite(finished)||!Number.isFinite(registered)||
      registered>=started||finished-started<600000)fail('INVALID_PREREGISTERED_STUDY_WINDOW');
  // Host clocks are independent: do not subtract host wall timestamps from
  // provider wall times. Check only own start/finish and bounded timestamps.
  const hostStart=asTime(h.body.startedAt),hostFinish=asTime(h.body.finishedAt);
  if(!Number.isFinite(hostStart)||!Number.isFinite(hostFinish)||
      hostFinish<hostStart||registered>=hostStart)fail('HOST_WINDOW_INVALID');

  const events=uniqueMap(p.body.events,'eventId');
  const receipts=uniqueMap(h.body.receipts,'eventId');
  if(events.size!==receipts.size)fail('MISSING_EXTERNAL_HOST_EFFECTS');
  const providerTimes=[];
  let previousSend=-1;
  for(const [id,e] of events) {
    if(e.accepted!==true || !finiteRate(e.sendElapsedMs) ||
        e.sendElapsedMs<previousSend || e.sendElapsedMs>finished-started ||
        !finiteRate(e.providerAcknowledgementMs))fail('INVALID_PROVIDER_OBSERVATION');
    previousSend=e.sendElapsedMs;
    providerTimes.push(e.providerAcknowledgementMs);
    if(!receipts.has(id))fail('HOST_RECEIPT_MISSING_EVENT');
  }
  // Independently read durable EI rows (not only aggregate receipt counts).
  // A matching count with a different wake or receipt is NOT the same effect.
  const eiRows=uniqueMap(ei.durableReceipts,'eventId');
  if(eiRows.size!==events.size)fail('EI_DURABLE_ROW_COUNT_MISMATCH');
  const wakeIds=new Set(),receiptIds=new Set(),hostTimes=[];
  let latestHostCompletionElapsedMs=0;
  for(const [id,e] of receipts) {
    if(!events.has(id)||!validName(e.wakeId)||!validName(e.runtimeReceiptId)||
        wakeIds.has(e.wakeId)||receiptIds.has(e.runtimeReceiptId)||
        e.effectCommitted!==true||!finiteRate(e.hostEffectMs)||
        !finiteRate(e.completedElapsedMs)||
        e.completedElapsedMs > hostFinish-hostStart)fail('INVALID_HOST_RECEIPT');
    const stored=eiRows.get(id);
    if(!stored||stored.wakeId!==e.wakeId ||
        stored.runtimeReceiptId!==e.runtimeReceiptId ||
        stored.status!=='delivered')fail('SIGNED_HOST_RECEIPT_DISAGREES_WITH_EI');
    wakeIds.add(e.wakeId);receiptIds.add(e.runtimeReceiptId);hostTimes.push(e.hostEffectMs);
    latestHostCompletionElapsedMs=Math.max(latestHostCompletionElapsedMs,e.completedElapsedMs);
  }
  const b=preRegisteredSloBudgets;
  if(!finiteRate(b.providerAcknowledgementP99MaxMs)||!finiteRate(b.hostEffectP99MaxMs)||
      !finiteRate(b.minVerifiedWakesPerSecond)||b.minVerifiedWakesPerSecond<=0||
      b.maxDuplicateEffectRate!==0)fail('UNREGISTERED_SLO_BUDGET');
  if(ei.sourceCommitSha===undefined||typeof ei.sourceCommitSha!=='string'||
      !SHA.test(ei.sourceCommitSha)||ei.productionSloCertified!==false||
      ei.expectedWakes!==events.size||ei.persistedDeliveredWakes!==events.size||
      ei.verifiedWakes!==events.size||ei.duplicateHostEffects!==0||
      ei.wakeSettlement?.settled!==true||ei.wakeSettlement?.dueWakeBacklog!==0||
      ei.wakeSettlement?.pendingWakeDeliveries!==0||ei.wakeSettlement?.deadLetterWakeDeliveries!==0||
      ei.wakeSettlement?.verifiedHostReceipts!==events.size)fail('EI_DURABLE_RECONCILIATION_FAILED');

  const providerP99=p99(providerTimes),hostP99=p99(hostTimes);
  // Measure durable effect throughput over BOTH signed local measurement
  // windows, not just provider send time: a slow external host must not pass
  // by eventually completing a backlog long after provider traffic stopped.
  // Never subtract provider and host timestamps from different clocks.
  const measuredWindowMs=Math.max(finished-started,hostFinish-hostStart,latestHostCompletionElapsedMs);
  const observedWakesPerSecond=events.size/(measuredWindowMs/1000);
  const metBudgets=providerP99<=b.providerAcknowledgementP99MaxMs &&
    hostP99<=b.hostEffectP99MaxMs &&
    observedWakesPerSecond>=b.minVerifiedWakesPerSecond;
  return Object.freeze({
    schema:'event-intelligence.independent-provider-host-evidence-assessment.v1',
    status:metBudgets?'eligible-for-independent-review':'budget-failed',
    workloadId:ei.workloadId,samples:events.size,providerEvidenceSha256:p.sha256,
    hostEvidenceSha256:h.sha256,providerKeySha256:p.keySha256,
    hostKeySha256:h.keySha256,providerAckP99Ms:providerP99,
    hostEffectP99Ms:hostP99,observedWakesPerSecond,measuredWindowSeconds:measuredWindowMs/1000,
    statusDoesNotCertifySeparateInfrastructure:true,
    independentEnvironmentAttestationRequired:true,
    productionSloCertified:false,
    limitations:['Independent assessor must verify real provider/host ownership and networking',
      'Monotonic within-origin latency only; no cross-clock latency subtraction',
      'No database HA, WORM retention, transport capture provenance or raw public archive verification',
      'All three >=600-second profiles, separate provider transport and externally measured EI segment latencies still required'],
  });
}
