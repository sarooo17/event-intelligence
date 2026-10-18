import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
const matrix=JSON.parse(readFileSync(new URL('../docs/security-threat-model-v1.json',import.meta.url)));
const root=new URL('../',import.meta.url);
const ownerByBoundary=Object.freeze({
  'transport-auth':'host',
  'registry-rebind':'host+ei',
  'principal-authorization':'host',
  'tenant-scope':'host+ei',
  'event-json-ingress':'ei',
  'source-gaps':'ei+host',
  'derived-lineage':'ei+host',
  'semantic-evaluation':'host',
  'wake-receipts':'host+ei',
  'operational-telemetry':'ei+host',
  'audit-and-retention':'operator',
  'release-publish':'operator',
});
const required=Object.keys(ownerByBoundary);

test('threat model documents all P0 authority boundaries and referenced existing evidence',()=>{
  assert.equal(matrix.schema,'event-intelligence.security-threat-model.v1');
  assert.equal(matrix.securitySignoff,'pending-independent-review');
  assert.deepEqual(matrix.boundaries.map(x=>x.id).sort(),[...required].sort());
  assert.equal(new Set(matrix.boundaries.map(x=>x.id)).size,required.length);
  for(const boundary of matrix.boundaries){
    assert.equal(boundary.authorityOwner,ownerByBoundary[boundary.id],
      'privileged responsibility must not drift across EI/host/operator');
    assert.equal(boundary.status,'partial',
      'no unreviewed host control may be represented as enforced');
    assert.ok(boundary.threat.length>=20,boundary.id);
    assert.ok(boundary.residual.length>=30,boundary.id);
    assert.ok(Array.isArray(boundary.evidence) && boundary.evidence.length>0,boundary.id);
    for(const path of boundary.evidence){
      assert.ok(/^test\/[a-z0-9-]+\.test\.mjs$/.test(path),path);
      assert.equal(existsSync(new URL(path,root)),true,'Missing referenced proof: '+path);
    }
  }
});

test('high-risk external authority and known residuals cannot be presented as certified',()=>{
  const map=Object.fromEntries(matrix.boundaries.map(x=>[x.id,x]));
  assert.equal(map['transport-auth'].authorityOwner,'host');
  assert.equal(map['principal-authorization'].authorityOwner,'host');
  assert.equal(map['semantic-evaluation'].authorityOwner,'host');
  for(const id of ['registry-rebind','tenant-scope','source-gaps',
    'wake-receipts','audit-and-retention']){
    assert.equal(map[id].status,'partial',id);
  }
  assert.ok(map['registry-rebind'].residual.includes('queued'));
  assert.ok(map['wake-receipts'].residual.includes('exactly-once'));
});


test('all twelve authority owners are fixed, including derived provenance and publication',()=>{
  const actual=Object.fromEntries(matrix.boundaries.map(x=>
    [x.id,x.authorityOwner]));
  assert.deepEqual(actual,ownerByBoundary);
  assert.equal(actual['derived-lineage'],'ei+host');
  assert.equal(actual['release-publish'],'operator');
  const controls=matrix.boundaries.find(x=>x.id==='principal-authorization');
  assert.ok(controls.evidence.includes('test/neutral-facade-conformance.test.mjs'),
    'the authority matrix must cite a real exercised control-denial test');
});


test('host-owned obligations stay marked partial and lineage cites behavioral coverage',()=>{
  const map=Object.fromEntries(matrix.boundaries.map(x=>[x.id,x]));
  for(const id of ['transport-auth','principal-authorization','semantic-evaluation']){
    assert.equal(map[id].status,'partial',id);
  }
  assert.ok(map['derived-lineage'].evidence.includes('test/derived-events.test.mjs'));
  assert.ok(map['derived-lineage'].evidence.includes('test/trigger-explain-bounds.test.mjs'));
  assert.equal(matrix.securitySignoff,'pending-independent-review');
});
