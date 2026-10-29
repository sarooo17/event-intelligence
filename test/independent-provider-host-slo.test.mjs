import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { assessIndependentProviderHostEvidence } from '../scripts/evidence/independent-provider-host-slo.mjs';

const key=()=>{
  const pair=generateKeyPairSync('ed25519');
  return {secret:pair.privateKey,publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'}).toString()};
};
const providerKey=key(),hostKey=key();
const signBytes=(body,secret,keyId)=>{
  const bytes=Buffer.from(JSON.stringify(body));
  return {bytes,signature:sign(null,bytes,secret).toString('base64'),keyId};
};
const start='2026-10-29T10:00:00.000Z';
const finish='2026-10-29T10:10:00.100Z';
function fixture(){
  const workloadId='external-slo-001';
  const events=Array.from({length:1200},(_,i)=>({
    eventId:'event:'+i,accepted:true,sendElapsedMs:i*500,
    providerAcknowledgementMs:12+(i%20)
  }));
  const receipts=Array.from({length:1200},(_,i)=>({
    eventId:'event:'+i,wakeId:'wake:'+i,
    runtimeReceiptId:'receipt:'+i,effectCommitted:true,hostEffectMs:4+(i%10),
  }));
  const p={schema:'event-intelligence.provider-observations.v1',
    providerId:'external-provider',workloadId,startedAt:start,finishedAt:finish,events};
  const h={schema:'event-intelligence.host-observations.v1',
    hostId:'external-host',workloadId,startedAt:start,finishedAt:finish,receipts};
  const ei={workloadId,sourceCommitSha:'a'.repeat(64),
    durableReceipts:receipts.map(x=>({eventId:x.eventId,wakeId:x.wakeId,runtimeReceiptId:x.runtimeReceiptId,status:'delivered'})),
    productionSloCertified:false,expectedWakes:1200,
    persistedDeliveredWakes:1200,verifiedWakes:1200,duplicateHostEffects:0,
    wakeSettlement:{settled:true,verifiedHostReceipts:1200,dueWakeBacklog:0,
      pendingWakeDeliveries:0,deadLetterWakeDeliveries:0}};
  const preRegisteredSloBudgets={registeredAt:'2026-10-28T10:00:00Z',
    providerAcknowledgementP99MaxMs:100,
    hostEffectP99MaxMs:100,minVerifiedWakesPerSecond:1,maxDuplicateEffectRate:0};
  return {p,h,ei,preRegisteredSloBudgets};
}
function evidence(input,mutateP,mutateH){
  const f=fixture();
  mutateP?.(f.p);mutateH?.(f.h);
  return {provider:signBytes(f.p,providerKey.secret,'provider-key'),
    host:signBytes(f.h,hostKey.secret,'host-key'),
    expectedProviderKeyId:'provider-key',expectedHostKeyId:'host-key',
    trustedProviderPublicKeyPem:providerKey.publicKeyPem,
    trustedHostPublicKeyPem:hostKey.publicKeyPem,
    expectedProviderId:'external-provider',expectedHostId:'external-host',
    ei:f.ei,preRegisteredSloBudgets:f.preRegisteredSloBudgets,
    ...input};
}
const check=x=>assessIndependentProviderHostEvidence(x);

test('distinct signed raw source/host, 1200 durable host effects, 600s and frozen budgets are review-eligible, never certified',()=>{
  const result=check(evidence());
  assert.equal(result.status,'eligible-for-independent-review');
  assert.equal(result.samples,1200);
  assert.equal(result.productionSloCertified,false);
  assert.equal(result.independentEnvironmentAttestationRequired,true);
  assert.equal(result.providerAckP99Ms,31);
  assert.equal(result.hostEffectP99Ms,13);
  assert.match(result.providerEvidenceSha256,/^[0-9a-f]{64}$/);
});

test('any modified signature, shared key or ambiguous raw JSON fails without false signoff',()=>{
  const tampered=evidence();
  tampered.provider.bytes[3]^=1;
  assert.throws(()=>check(tampered),/EI_INDEPENDENT_SLO_EVIDENCE_REFUSED/);
  const same=evidence();
  same.trustedHostPublicKeyPem=same.trustedProviderPublicKeyPem;
  assert.throws(()=>check(same),/SIGNATURE_MISMATCH|SIGNERS_SHARE_KEY/);
  const invalid=evidence();
  const raw=JSON.parse(invalid.provider.bytes.toString());
  const noncanonical=Buffer.from(' '+JSON.stringify(raw));
  invalid.provider.bytes=noncanonical;
  invalid.provider.signature=sign(null,noncanonical,providerKey.secret).toString('base64');
  assert.throws(()=>check(invalid),/NONCANONICAL_SIGNED_JSON/);
});

test('lost/missing/duplicate host wake, partial provider events and retrospective budgets fail closed',()=>{
  const partial=evidence({},null,h=>{h.receipts.pop()});
  assert.throws(()=>check(partial),/MISSING_EXTERNAL_HOST_EFFECTS/);
  const missing=evidence({},null,h=>{h.receipts[100].eventId='event:unknown'});
  assert.throws(()=>check(missing),/HOST_RECEIPT_MISSING_EVENT/);
  const duplicate=evidence({},null,h=>{h.receipts[20].wakeId=h.receipts[19].wakeId});
  assert.throws(()=>check(duplicate),/INVALID_HOST_RECEIPT/);
  const late=evidence();
  late.preRegisteredSloBudgets.registeredAt=start;
  assert.throws(()=>check(late),/INVALID_PREREGISTERED_STUDY_WINDOW/);
  const forged=evidence();
  forged.ei.durableReceipts[100].runtimeReceiptId='receipt:wrong';
  assert.throws(()=>check(forged),/SIGNED_HOST_RECEIPT_DISAGREES_WITH_EI/);
  const absent=evidence();
  absent.ei.durableReceipts.pop();
  assert.throws(()=>check(absent),/EI_DURABLE_ROW_COUNT_MISMATCH/);
  const wrong=evidence();
  wrong.ei.persistedDeliveredWakes=1199;
  assert.throws(()=>check(wrong),/EI_DURABLE_RECONCILIATION_FAILED/);
  const missingProvider=evidence({},p=>p.events.pop());
  assert.throws(()=>check(missingProvider),/MISSING_EXTERNAL_HOST_EFFECTS/);
});

test('signed evidence with p99 or verified throughput below precommitted budget is rejected',()=>{
  const e=evidence();
  e.preRegisteredSloBudgets.providerAcknowledgementP99MaxMs=10;
  assert.equal(check(e).status,'budget-failed');
  assert.equal(check(e).productionSloCertified,false);
});
