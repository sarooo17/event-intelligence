import test from 'node:test';
import assert from 'node:assert/strict';
import {AuditChain,buildAuditRecordAt,canonicalJson,sha256Hex} from
 '../dist/src/intelligenceProtocol/index.js';

function input(i){
 return {auditId:'audit-fast-'+i,traceId:'trace-fast',
  timestamp:new Date(Date.UTC(2026,10,3,10,0,i)).toISOString(),
  kind:'trigger.created',entityType:'trigger',entityId:'trigger-'+i,
  ...(i%2?{details:{nested:{b:2,a:i},array:[i,'x']}}:{})};
}

test('single-record builder reproduces every canonical AuditChain record byte for byte',async()=>{
 const chain=new AuditChain();
 let head=null;
 for(let i=0;i<8;i++){
  const row=input(i);
  const direct=await buildAuditRecordAt(row,i,head?.hash??null);
  const existing=await chain.append(row);
  assert.deepEqual(direct,existing);
  assert.equal(direct.sequence,i);
  assert.equal(direct.previousHash,head?.hash??null);
  const {hash,...unsigned}=direct;
  assert.equal(hash,await sha256Hex(canonicalJson(unsigned)));
  head=direct;
 }
 assert.equal(await chain.verify(),true);
});
test('single-record builder rejects impossible predecessor/sequence pairs',async()=>{
 const row=input(0);
 for(const [seq,head] of [
  [-1,null],[0,'a'.repeat(64)],[1,null],[2,'not-a-hash'],
  [Number.MAX_SAFE_INTEGER+1,'b'.repeat(64)],[1,'A'.repeat(64)]
 ]){
  await assert.rejects(buildAuditRecordAt(row,seq,head),
   /Invalid audit sequence\/predecessor pair/);
 }
});
