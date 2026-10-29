import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { createHostMcpEventsConnection } from '../scripts/lib/mcp-events-client.mjs';
import { createMcpRegistryAdapter } from '../scripts/host-integration.mjs';

const base=new URL('../',import.meta.url);
const read=(path)=>readFileSync(new URL(path,base),'utf8');
const ledger=JSON.parse(read('docs/security-negative-evidence-v1.json'));
const model=JSON.parse(read('docs/security-threat-model-v1.json'));
const manifest=JSON.parse(read('package.json'));

test('all twelve trust boundaries cite actual negative security tests and owners',()=>{
  assert.equal(ledger.schema,'event-intelligence.security-negative-evidence.v1');
  assert.equal(ledger.independentSignoff,'pending-independent-review');
  const actual=new Map(ledger.negativeHypotheses.map(x=>[x.boundaryId,x]));
  assert.equal(actual.size,12);
  assert.deepEqual([...actual.keys()].sort(),
    model.boundaries.map(x=>x.id).sort());
  for(const boundary of model.boundaries){
    const row=actual.get(boundary.id);
    assert.equal(row.authorityOwner,boundary.authorityOwner,boundary.id);
    assert.equal(row.riskAcceptedForRelease,false,boundary.id);
    assert.ok(row.residual.length>30,boundary.id);
    assert.ok(existsSync(new URL(row.proof.file,base)));
    assert.ok(row.proof.file.startsWith('test/'));
    const source=read(row.proof.file);
    const tick=String.fromCharCode(96);
    assert.ok(
      source.includes("'"+row.proof.testTitle+"'") ||
      source.includes('"'+row.proof.testTitle+'"') ||
      source.includes(tick+row.proof.testTitle+tick),
      'negative test missing: '+row.proof.file+': '+row.proof.testTitle,
    );
  }
});

test('externally owned authentication, approval and permissions never become EI package capabilities',async()=>{
  assert.deepEqual(ledger.noEiOwnedPowers,[
    'provider OAuth and token acquisition',
    'principal authorization and policy engine',
    'host approvals and tool permissions',
    'external runtime effect authorization',
  ]);
  const publicExports=Object.keys(manifest.exports);
  assert.ok(publicExports.length>0);
  for(const entry of publicExports){
    assert.doesNotMatch(entry,/oauth|login|credential|approval|permission|policy-engine/i);
  }
  // Host supplies an already connected MCP transport. EI has no OAuth
  // exchange, credential acquisition or fallback unauthenticated request.
  assert.throws(()=>createHostMcpEventsConnection({
    connectionId:'no-transport',getCapabilities:async()=>({}),
  }),/requires request\(method, params\)/);
  assert.throws(()=>createHostMcpEventsConnection({
    connectionId:'no-capabilities',request:async()=>({}),
  }),/requires getCapabilities\(\)/);
  assert.throws(()=>createMcpRegistryAdapter({}),/requires listConnections/);
  const adapter=createMcpRegistryAdapter({
    listConnections:async()=>[],
  });
  assert.deepEqual(await adapter.listConnections(),[]);
  assert.equal('authorize' in adapter,false);
  assert.equal('acquireToken' in adapter,false);
});

test('security evidence cannot silently self-certify or remove external trust owners',()=>{
  assert.equal(model.securitySignoff,'pending-independent-review');
  assert.equal(ledger.independentSignoff,'pending-independent-review');
  assert.ok(model.boundaries.every(x=>x.status==='partial'));
  assert.ok(ledger.acceptedTrustModel.includes('never an authorization decision'));
  for(const id of ['transport-auth','principal-authorization','semantic-evaluation']){
    const boundary=model.boundaries.find(x=>x.id===id);
    assert.equal(boundary.authorityOwner,'host');
  }
  for(const boundary of ledger.negativeHypotheses){
    assert.equal(boundary.riskAcceptedForRelease,false);
  }
});
