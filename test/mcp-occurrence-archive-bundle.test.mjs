import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mcpArchiveGenesis, mcpArchiveRecordHash } from '../scripts/lib/mcp-occurrence-archive.mjs';
import { writeMcpOccurrenceArchiveBundle as packedArchiveWriter } from 'mcp-event-intelligence/storage/postgres/archive';
import {
  writeMcpOccurrenceArchiveBundle, verifyMcpOccurrenceArchiveBundle,
  verifyMcpOccurrenceArchiveBundleFile,
} from '../scripts/lib/mcp-occurrence-archive-bundle.mjs';

const schema='event-intelligence.mcp-occurrence-archive.v1';
function fixture(){
  const scopeId='archive-scope';
  const genesisHash=mcpArchiveGenesis(scopeId);
  const records=[1,2,3,4,5].map(i=>JSON.stringify({
    sequence:i,serverId:'source',subscriptionId:'subscription',
    event:{eventId:'event-'+i,name:'fixture.archive.event',
      timestamp:'2026-10-19T12:00:00.000Z',data:{integer:i}},
  }));
  let hash=genesisHash;
  for(const payload of records)hash=mcpArchiveRecordHash(scopeId,hash,payload);
  const cp={schema,scopeId,genesisHash,endSequence:records.length,headHash:hash};
  return {cp,records};
}
function storeFor(cp,records,{failPage=false}={}){
  let called=0;
  return {async getMcpOccurrenceArchiveWindow({checkpoint,afterSequence,previousHash,limit}){
    called++;
    if(failPage && called===2)throw new Error('source unavailable during archive');
    assert.equal(checkpoint,cp);
    const page=records.slice(afterSequence,afterSequence+limit);
    let hash=previousHash;
    for(const row of page)hash=mcpArchiveRecordHash(cp.scopeId,hash,row);
    return {schema,scopeId:cp.scopeId,afterSequence,previousHash,limit,
      records:page,endSequence:afterSequence+page.length,headHash:hash,
      hasMore:afterSequence+page.length<cp.endSequence};
  },get calls(){return called;}};
}
test('local archive bundle writes only a full independently verified source snapshot',async()=>{
  assert.equal(packedArchiveWriter,writeMcpOccurrenceArchiveBundle,
    'published npm export must resolve to operator archive API');
  const dir=await mkdtemp(join(tmpdir(),'ei-archive-bundle-'));
  try {
    const path=join(dir,'verified.json');
    const {cp,records}=fixture();
    const store=storeFor(cp,records);
    const result=await writeMcpOccurrenceArchiveBundle(store,{
      trustedCheckpoint:cp,outputPath:path,pageSize:2});
    assert.equal(result.endSequence,5);
    assert.equal(store.calls,3);
    assert.equal(result.headHash,cp.headHash);
    assert.equal(await verifyMcpOccurrenceArchiveBundleFile(path,{trustedCheckpoint:cp}),true);
    const bytes=await readFile(path,'utf8');
    const artifact=JSON.parse(bytes);
    assert.equal(verifyMcpOccurrenceArchiveBundle(artifact,{trustedCheckpoint:cp}),true);
    assert.equal((await stat(path)).mode & 0o777,0o600,
      'archive must be private to the operator');
    const tampered=structuredClone(artifact);
    tampered.pages[0].records[0]=tampered.pages[0].records[0].replace('"integer":1','"integer":999');
    assert.equal(verifyMcpOccurrenceArchiveBundle(tampered,{trustedCheckpoint:cp}),false);
    const missing=structuredClone(artifact);missing.pages.pop();
    assert.equal(verifyMcpOccurrenceArchiveBundle(missing,{trustedCheckpoint:cp}),false);
    const appended=structuredClone(artifact);
    appended.pages.push({
      schema:cp.schema,scopeId:cp.scopeId,afterSequence:cp.endSequence,
      previousHash:cp.headHash,limit:2,records:[],
      endSequence:cp.endSequence,headHash:cp.headHash,hasMore:false,
    });
    assert.equal(verifyMcpOccurrenceArchiveBundle(appended,{trustedCheckpoint:cp}),false,
      'an archive must not accept extra no-progress pages beyond the terminal hash');
    assert.equal(verifyMcpOccurrenceArchiveBundle(artifact,{trustedCheckpoint:{
      ...cp,scopeId:'other',
    }}),false);
    await assert.rejects(()=>writeMcpOccurrenceArchiveBundle(store,{
      trustedCheckpoint:cp,outputPath:path,pageSize:2}),/exists/);
    assert.equal(await readFile(path,'utf8'),bytes,
      'rerun cannot overwrite a prior successful export');
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('failed, too-small or over-budget source exports never publish completed artifacts',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ei-archive-failed-'));
  try {
    const {cp,records}=fixture();
    const interrupted=join(dir,'interrupted.json');
    await assert.rejects(()=>writeMcpOccurrenceArchiveBundle(
      storeFor(cp,records,{failPage:true}),{
        trustedCheckpoint:cp,outputPath:interrupted,pageSize:2,
      }),/unavailable/);
    assert.equal(await verifyMcpOccurrenceArchiveBundleFile(interrupted,{trustedCheckpoint:cp}),false);
    const tooSmall=join(dir,'too-small.json');
    await assert.rejects(()=>writeMcpOccurrenceArchiveBundle(storeFor(cp,records),{
      trustedCheckpoint:cp,outputPath:tooSmall,pageSize:2,maxBytes:1024,
    }),/byte budget/);
    assert.equal(await verifyMcpOccurrenceArchiveBundleFile(tooSmall,{trustedCheckpoint:cp}),false);
    const existing=join(dir,'stale.json');
    await writeFile(existing,'{"status":"completed","old":true}');
    const noRead=storeFor(cp,records);
    await assert.rejects(()=>writeMcpOccurrenceArchiveBundle(noRead,{
      trustedCheckpoint:cp,outputPath:existing,pageSize:2,
    }),/exists/);
    assert.equal(noRead.calls,0);
    assert.equal(await readFile(existing,'utf8'),'{"status":"completed","old":true}');
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('empty pinned source yields a complete zero-page archive, not fabricated source events',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ei-archive-empty-'));
  try{
    const scopeId='empty',genesisHash=mcpArchiveGenesis(scopeId);
    const cp={schema,scopeId,genesisHash,endSequence:0,headHash:genesisHash};
    const noEvents=storeFor(cp,[]);
    const path=join(dir,'empty.json');
    await writeMcpOccurrenceArchiveBundle(noEvents,{trustedCheckpoint:cp,outputPath:path});
    assert.equal(noEvents.calls,0);
    assert.equal(await verifyMcpOccurrenceArchiveBundleFile(path,{trustedCheckpoint:cp}),true);
  }finally{await rm(dir,{recursive:true,force:true});}
});
