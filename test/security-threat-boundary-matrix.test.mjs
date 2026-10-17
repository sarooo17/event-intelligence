import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
const matrix=JSON.parse(readFileSync(new URL('../docs/security-threat-model-v1.json',import.meta.url)));
const root=new URL('../',import.meta.url);
const required=[
  'transport-auth','registry-rebind','principal-authorization',
  'tenant-scope','event-json-ingress','source-gaps','derived-lineage',
  'semantic-evaluation','wake-receipts','operational-telemetry',
  'audit-and-retention','release-publish',
];

test('threat model documents all P0 authority boundaries and referenced existing evidence',()=>{
  assert.equal(matrix.schema,'event-intelligence.security-threat-model.v1');
  assert.equal(matrix.securitySignoff,'pending-independent-review');
  assert.deepEqual(matrix.boundaries.map(x=>x.id).sort(),[...required].sort());
  assert.equal(new Set(matrix.boundaries.map(x=>x.id)).size,required.length);
  for(const boundary of matrix.boundaries){
    assert.ok(['host','ei','host+ei','ei+host','operator'].includes(boundary.authorityOwner),
      boundary.id);
    assert.ok(['partial','host-enforced'].includes(boundary.status),boundary.id);
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
