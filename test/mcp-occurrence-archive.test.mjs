import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mcpArchiveGenesis, mcpArchiveRecordHash,
  verifyMcpOccurrenceArchiveWindow,
} from '../scripts/lib/mcp-occurrence-archive.mjs';

const schema = 'event-intelligence.mcp-occurrence-archive.v1';
function example() {
  const scopeId = 'customer-A';
  const genesisHash = mcpArchiveGenesis(scopeId);
  const records = [1,2,3].map(sequence=>({
    sequence,serverId:'fixture-provider',subscriptionId:'subscription-1',
    event:{
      eventId:'source-'+sequence,name:'fixture.event',
      timestamp:'2026-10-19T01:02:03.000Z',
      data:{nested:{z:4,a:1},sequence},
    },
  }));
  let first=genesisHash;
  for(const record of records) first=mcpArchiveRecordHash(scopeId,first,record);
  const cp={schema,scopeId,genesisHash,endSequence:3,headHash:first};
  const p1={schema,scopeId,afterSequence:0,previousHash:genesisHash,
    limit:2,records:records.slice(0,2),endSequence:2,hasMore:true,headHash:''};
  p1.headHash=records.slice(0,2).reduce(
    (hash,record)=>mcpArchiveRecordHash(scopeId,hash,record),genesisHash);
  const p2={schema,scopeId,afterSequence:2,previousHash:p1.headHash,
    limit:2,records:records.slice(2),endSequence:3,hasMore:false,headHash:first};
  return {cp,p1,p2};
}
function verify(proof,cp,after,previous,limit=2) {
  return verifyMcpOccurrenceArchiveWindow(proof,{
    trustedCheckpoint:cp,trustedAfterSequence:after,
    trustedPreviousHash:previous,trustedLimit:limit,
  });
}
test('MCP archive SHA256 is domain/scope bounded and canonical across JSON object key order',()=>{
  const a={sequence:1,serverId:'provider',subscriptionId:null,
    event:{eventId:'one',name:'source',data:{b:3,a:2}}};
  const b={event:{data:{a:2,b:3},name:'source',eventId:'one'},
    subscriptionId:null,serverId:'provider',sequence:1};
  const g=mcpArchiveGenesis('customer-A');
  assert.equal(mcpArchiveRecordHash('customer-A',g,a),mcpArchiveRecordHash('customer-A',g,b));
  assert.notEqual(mcpArchiveGenesis('customer-A'),mcpArchiveGenesis('customer-B'));
  assert.notEqual(mcpArchiveRecordHash('customer-A',g,a),mcpArchiveRecordHash('customer-B',mcpArchiveGenesis('customer-B'),a));
});
test('verified complete archive pages require independently pinned predecessor and terminal',()=>{
  const {cp,p1,p2}=example();
  assert.equal(verify(p1,cp,0,cp.genesisHash),true);
  assert.equal(verify(p2,cp,2,p1.headHash),true);
  assert.equal(verifyMcpOccurrenceArchiveWindow(p2),false);
  const end={...p2,afterSequence:3,previousHash:cp.headHash,records:[],endSequence:3,headHash:cp.headHash};
  assert.equal(verify(end,cp,3,cp.headHash),true);
  for (const mutate of [
    p=>{p.records[0].event.data.sequence=998;},
    p=>{p.records.reverse();},
    p=>{p.records.pop();},
    p=>{p.scopeId='customer-B';},
    p=>{p.previousHash='0'.repeat(64);},
    p=>{p.hasMore=false;},
    p=>{p.headHash='0'.repeat(64);},
  ]) {
    const corrupted=structuredClone(p1);
    mutate(corrupted);
    assert.equal(verify(corrupted,cp,0,cp.genesisHash),false);
  }
  const truncate=structuredClone(p2);
  truncate.records=[];
  truncate.endSequence=2;truncate.headHash=p1.headHash;
  assert.equal(verify(truncate,cp,2,p1.headHash),false,
    'pinned tail cannot be truncated');
  const forged=structuredClone(cp);forged.headHash='f'.repeat(64);
  assert.equal(verify(p2,forged,2,p1.headHash),false);
});
