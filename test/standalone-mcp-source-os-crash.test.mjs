import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStandaloneSource} from '../scripts/validation/standalone-mcp-source.mjs';

const digest=x=>createHash('sha256').update(x).digest('hex');

test('E48-A real separate provider OS SIGKILL causes actual MCP transport outage and cold durable replay', {skip:process.platform==='win32',timeout:20000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ei-e48-provider-kill-'));
 const keys=generateKeyPairSync('ed25519');
 const source={
  logPath:join(dir,'provider-immutable.jsonl'),
  privateKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}),
  scopeId:'e48-crash-fixture',
  sourceKeyDigest:digest('crash-connection::fixture.changed::{}'),
  connectionId:'crash-connection',serverId:'crash-service',
  eventName:'fixture.changed',argumentsCanonical:'{}',
 };
 const token='e48-isolated-os-crash-test-private-token-2026';
 const env={...process.env,EI_SOURCE_LOG_PATH:source.logPath,
  EI_SOURCE_PRIVATE_KEY_PEM:source.privateKeyPem,
  EI_SOURCE_SCOPE_ID:source.scopeId,
  EI_SOURCE_KEY_DIGEST:source.sourceKeyDigest,
  EI_SOURCE_CONNECTION_ID:source.connectionId,
  EI_SOURCE_SERVER_ID:source.serverId,
  EI_SOURCE_EVENT_NAME:source.eventName,
  EI_SOURCE_ARGUMENTS_CANONICAL:'{}',
  EI_SOURCE_CONTROL_TOKEN:token,PORT:'0'};
 const child=spawn(process.execPath,
  ['scripts/validation/run-standalone-mcp-source.mjs'],
  {cwd:process.cwd(),env,stdio:['ignore','pipe','pipe']});
 const output=createInterface({input:child.stdout});
 const exited=once(child,'exit');
 let killed=false,restarted;
 try{
  const [line]=await Promise.race([
   once(output,'line'),
   exited.then(()=>{throw Error('provider exited before healthy');}),
  ]);
  const ready=JSON.parse(line);
  assert.equal(ready.event,'ei_source_listening');
  const endpoint='http://127.0.0.1:'+ready.port;
  const rpc=async(path,body)=>fetch(endpoint+path,{
   method:'POST',headers:{authorization:'Bearer '+token,
    'content-type':'application/json'},body:JSON.stringify(body),
   signal:AbortSignal.timeout(2500)});
  let response=await rpc('/control/append',{
   eventId:'e48-crash-event',data:{businessValue:'fixture-only'}});
  assert.equal(response.status,200);
  assert.equal((await response.json()).accepted,true);
  response=await rpc('/control/seal',{});
  assert.equal(response.status,200);
  const oldSeal=(await response.json()).completeThroughAt;
  // Deliberately SIGKILL without provider shutdown cleanup. This is
  // physical separate-process outage, NOT a simulated status flag.
  killed=child.kill('SIGKILL');
  assert.equal(killed,true);
  const [code,signal]=await exited;
  assert.equal(signal,'SIGKILL');
  assert.notEqual(code,0);
  await assert.rejects(()=>rpc('/rpc',{jsonrpc:'2.0',id:1,
    method:'events/poll',params:{cursor:'source-v1:0'}}),
   /fetch|abort|connect|socket/i);
  // The lock must remain; blindly restarting during ambiguous OS
  // death would endanger a legitimate writer.
  await assert.rejects(()=>createStandaloneSource(source),
   e=>e.code==='SOURCE_WRITER_LOCKED');
  const raw=await readFile(source.logPath,'utf8');
  assert.match(raw,/"eventId":"e48-crash-event"/);
  assert.match(raw,/"kind":"seal"/);
  // Explicit manual operator simulation AFTER the child has demonstrably
  // exited; preserve the log and remove only the orphan lock directory.
  await rm(source.logPath+'.writer-lock',{recursive:true,force:true});
  restarted=await createStandaloneSource(source);
  const all=restarted.poll({cursor:'source-v1:0',maxEvents:50});
  assert.deepEqual(all.events.map(x=>x.eventId),['e48-crash-event']);
  assert.equal((await restarted.append({
   eventId:'e48-crash-event',data:{businessValue:'fixture-only'}})).accepted,false);
  const status=restarted.status();
  assert.equal(status.lastSeal,oldSeal);
  const newer=restarted.frontier({completenessRevision:1});
  assert.equal(newer.sourceLog.sequence,status.sequence);
  assert.equal(newer.sourceLog.head,status.head);
 }finally{
  await restarted?.close().catch(()=>{});
  if(!killed){child.kill('SIGKILL');await exited.catch(()=>{});}
  output.close();await rm(dir,{recursive:true,force:true});
 }
});
