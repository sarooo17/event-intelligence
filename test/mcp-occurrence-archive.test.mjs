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
  const raw = records.map(r => JSON.stringify(r));
  let first=genesisHash;
  for(const record of raw) first=mcpArchiveRecordHash(scopeId,first,record);
  const cp={schema,scopeId,genesisHash,endSequence:3,headHash:first};
  const p1={schema,scopeId,afterSequence:0,previousHash:genesisHash,
    limit:2,records:raw.slice(0,2),endSequence:2,hasMore:true,headHash:''};
  p1.headHash=raw.slice(0,2).reduce(
    (hash,record)=>mcpArchiveRecordHash(scopeId,hash,record),genesisHash);
  const p2={schema,scopeId,afterSequence:2,previousHash:p1.headHash,
    limit:2,records:raw.slice(2),endSequence:3,hasMore:false,headHash:first};
  return {cp,p1,p2};
}
function verify(proof,cp,after,previous,limit=2) {
  return verifyMcpOccurrenceArchiveWindow(proof,{
    trustedCheckpoint:cp,trustedAfterSequence:after,
    trustedPreviousHash:previous,trustedLimit:limit,
  });
}
test('MCP archive hash binds exact raw JSONB bytes without JavaScript numeric collisions',()=>{
  const scope='customer-A', g=mcpArchiveGenesis(scope);
  const rawA='{"sequence":1,"serverId":"provider","subscriptionId":null,"event":{"eventId":"one","name":"source","timestamp":"2026-10-19T00:00:00Z","data":{"amount":9007199254740992}}}';
  const rawB=rawA.replace('9007199254740992','9007199254740993');
  assert.equal(JSON.parse(rawA).event.data.amount, JSON.parse(rawB).event.data.amount,
    'JS Number would erase this material PostgreSQL JSONB difference');
  assert.notEqual(mcpArchiveRecordHash(scope,g,rawA),mcpArchiveRecordHash(scope,g,rawB));
  assert.notEqual(mcpArchiveGenesis('customer-A'),mcpArchiveGenesis('customer-B'));
  assert.notEqual(mcpArchiveRecordHash(scope,g,rawA),
    mcpArchiveRecordHash('customer-B',mcpArchiveGenesis('customer-B'),rawA));
  const invalid=JSON.stringify({sequence:1,serverId:'provider',subscriptionId:null,
    event:{eventId:'one',name:'source',timestamp:'invalid',data:{a:1}}});
  assert.throws(()=>mcpArchiveRecordHash(scope,g,invalid));
});
test('verified complete archive pages require independently pinned predecessor and terminal',()=>{
  const {cp,p1,p2}=example();
  assert.equal(verify(p1,cp,0,cp.genesisHash),true);
  assert.equal(verify(p2,cp,2,p1.headHash),true);
  assert.equal(verifyMcpOccurrenceArchiveWindow(p2),false);
  const end={...p2,afterSequence:3,previousHash:cp.headHash,records:[],endSequence:3,headHash:cp.headHash};
  assert.equal(verify(end,cp,3,cp.headHash),true);
  for (const mutate of [
    p=>{const altered=JSON.parse(p.records[0]);
         altered.event.data.sequence=998;
         p.records[0]=JSON.stringify(altered);},
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
