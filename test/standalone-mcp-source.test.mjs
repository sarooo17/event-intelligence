import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {createStandaloneSource} from
  '../scripts/validation/standalone-mcp-source.mjs';
import {verifyStandaloneOracle} from
  '../scripts/validation/standalone-mcp-source-oracle.mjs';

const hash=s=>createHash('sha256').update(s).digest('hex');
const keys=()=>generateKeyPairSync('ed25519');
const config=(dir,k,now)=>({
  logPath:join(dir,'source.jsonl'),
  privateKeyPem:k.privateKey.export({format:'pem',type:'pkcs8'}),
  scopeId:'tenant-one',sourceKeyDigest:hash('pinned-source-one'),
  connectionId:'provider-connection',serverId:'source-one',
  eventName:'sample.changed',argumentsCanonical:'{}',now,
});
const expected=c=>({scopeId:c.scopeId,sourceKeyDigest:c.sourceKeyDigest,
  connectionId:c.connectionId,serverId:c.serverId,eventName:c.eventName,
  argumentsCanonical:c.argumentsCanonical,completenessRevision:1});
const publicPem=k=>k.publicKey.export({format:'pem',type:'spki'});

test('first-party standalone log oracle independently verifies durable monotonic sealed history',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ei-source-fixture-'));
  const k=keys();let time=Date.UTC(2026,9,31,11,30,0);
  const c=config(dir,k,()=>time);
  let source;
  try{
    source=await createStandaloneSource(c);
    const first=await source.append({eventId:'event-1',data:{value:1}});
    assert.equal(first.accepted,true);
    assert.equal((await source.append({eventId:'event-1',data:{value:1}})).accepted,false);
    await assert.rejects(()=>source.append({eventId:'event-1',data:{value:2}}),
      e=>e.code==='SOURCE_EVENT_ID_CONFLICT');
    await assert.rejects(()=>source.append({eventId:'event-2'}),
      e=>e.code==='SOURCE_CLOCK_REGRESSION');
    time+=10;
    const seal=await source.seal();
    assert.equal(seal.revision,1);
    await assert.rejects(()=>source.append({eventId:'event-2'}),
      e=>e.code==='SOURCE_CLOCK_REGRESSION');
    time+=20;
    await source.append({eventId:'event-2',data:{value:2}});
    const polled=source.poll({cursor:'source-v1:0',maxEvents:1});
    assert.equal(polled.events.length,1);
    assert.equal(polled.hasMore,true);
    assert.deepEqual(source.poll({cursor:polled.cursor,maxEvents:20}).events
      .map(e=>e.eventId),['event-2']);
    assert.throws(()=>source.poll({cursor:'source-v1:999'}),
      e=>e.code==='SOURCE_CURSOR_INVALID');
    const signed=source.frontier({completenessRevision:1});
    const oracle=await verifyStandaloneOracle({logPath:c.logPath,
      sourceLog:signed.sourceLog,attestation:signed.attestation,
      publicKeyPem:publicPem(k),expected:expected(c),now:time+1});
    assert.equal(oracle.eventCount,2);
    assert.equal(oracle.thirdPartyCompletenessCertified,false);
    assert.equal(oracle.seal,seal.completeThroughAt);
    assert.deepEqual(oracle.events.map(x=>x.eventId),['event-1','event-2']);
    await assert.rejects(()=>verifyStandaloneOracle({logPath:c.logPath,
      sourceLog:signed.sourceLog,attestation:signed.attestation,
      publicKeyPem:publicPem(k),expected:{...expected(c),scopeId:'other'},
      now:time+1}),e=>e.code==='ORACLE_FRONTIER_UNVERIFIED');
    await assert.rejects(()=>verifyStandaloneOracle({logPath:c.logPath,
      sourceLog:signed.sourceLog,attestation:{...signed.attestation,
        signature:'a'.repeat(86)},publicKeyPem:publicPem(k),
      expected:expected(c),now:time+1}),
    e=>e.code==='ORACLE_SIGNATURE_INVALID');
    await assert.rejects(()=>verifyStandaloneOracle({logPath:c.logPath,
      sourceLog:signed.sourceLog,attestation:signed.attestation,
      publicKeyPem:publicPem(keys()),expected:expected(c),now:time+1}),
    e=>e.code==='ORACLE_SIGNATURE_INVALID');
    await source.setRevoked(true);
    assert.throws(()=>source.frontier({completenessRevision:2}),
      e=>e.code==='SOURCE_REVOKED');
    assert.throws(()=>source.poll(),e=>e.code==='SOURCE_REVOKED');
    assert.equal((await source.setRevoked(false)).revision,3);
    assert.throws(()=>source.frontier({completenessRevision:3}),
      e=>e.code==='SOURCE_UNSEALED');
    await assert.rejects(()=>verifyStandaloneOracle({logPath:c.logPath,
      sourceLog:source.status(),attestation:signed.attestation,
      publicKeyPem:publicPem(k),expected:expected(c),now:time+1}));
    time+=20;
    await source.seal();
    const newSigned=source.frontier({completenessRevision:3});
    const newProof=await verifyStandaloneOracle({logPath:c.logPath,
      sourceLog:newSigned.sourceLog,attestation:newSigned.attestation,
      publicKeyPem:publicPem(k),expected:{...expected(c),completenessRevision:3},
      now:time+1});
    assert.equal(newProof.revision,3);
    await source.close();source=null;
    const restarted=await createStandaloneSource(c);
    try{
      assert.equal(restarted.status().sequence,newSigned.sourceLog.sequence);
      assert.equal((await restarted.append({eventId:'event-1',data:{value:1}})).accepted,false);
    }finally{await restarted.close();}
    const raw=await readFile(c.logPath,'utf8');
    await writeFile(c.logPath,raw.replace('"value":2','"value":4'));
    await assert.rejects(()=>createStandaloneSource(c),
      e=>e.code==='SOURCE_LOG_CORRUPTED');
    await assert.rejects(()=>verifyStandaloneOracle({logPath:c.logPath,
      sourceLog:newSigned.sourceLog,attestation:newSigned.attestation,
      publicKeyPem:publicPem(k),expected:{...expected(c),completenessRevision:3},
      now:time+1}),e=>e.code==='ORACLE_CHAIN_INVALID');
  }finally{await source?.close().catch(()=>{});await rm(dir,{recursive:true,force:true});}
});

test('standalone HTTP provider and file oracle run in separate OS processes with private controls',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ei-source-process-'));
  const k=keys(),c=config(dir,k);
  const token='test-only-source-token-of-sufficient-size-2026';
  const child=spawn(process.execPath,['scripts/validation/run-standalone-mcp-source.mjs'],
    {cwd:process.cwd(),env:{...process.env,
      EI_SOURCE_LOG_PATH:c.logPath,
      EI_SOURCE_PRIVATE_KEY_PEM:c.privateKeyPem,
      EI_SOURCE_SCOPE_ID:c.scopeId,
      EI_SOURCE_KEY_DIGEST:c.sourceKeyDigest,
      EI_SOURCE_CONNECTION_ID:c.connectionId,
      EI_SOURCE_SERVER_ID:c.serverId,
      EI_SOURCE_EVENT_NAME:c.eventName,
      EI_SOURCE_ARGUMENTS_CANONICAL:c.argumentsCanonical,
      EI_SOURCE_CONTROL_TOKEN:token,PORT:'0',
    },stdio:['ignore','pipe','pipe']});
  const lines=createInterface({input:child.stdout});
  let exited=false;child.once('exit',()=>{exited=true;});
  try{
    const readReady=once(lines,'line');
    const [firstLine]=await Promise.race([readReady,
      once(child,'exit').then(()=>{throw Error('Provider died before ready');})]);
    const ready=JSON.parse(firstLine);assert.equal(ready.event,'ei_source_listening');
    const url='http://127.0.0.1:'+ready.port;
    const request=async(path,body,auth=true)=>{
      const res=await fetch(url+path,{method:'POST',
        headers:{'content-type':'application/json',
          ...(auth?{authorization:'Bearer '+token}:{})},
        body:JSON.stringify(body),signal:AbortSignal.timeout(3000)});
      return {status:res.status,data:await res.json()};
    };
    assert.equal((await request('/control/append',{eventId:'denied'},false)).status,401);
    assert.equal((await request('/control/append',{
      eventId:'backdated',timestamp:'2020-01-01T00:00:00.000Z'})).status,400);
    const e=await request('/control/append',{eventId:'one',data:{value:1}});
    assert.equal(e.status,200);assert.equal(e.data.accepted,true);
    const init=await request('/rpc',{jsonrpc:'2.0',id:1,method:'initialize'});
    assert.equal(init.data.result.capabilities.extensions['io.modelcontextprotocol/events'].listChanged,false);
    const list=await request('/rpc',{jsonrpc:'2.0',id:2,method:'events/list',eventName:'evil'});
    assert.equal(list.data.result.events[0].name,'sample.changed');
    assert.equal(list.data.result.resultType,'complete');
    const seal=await request('/control/seal',{});
    assert.equal(seal.status,200);
    const frontier=await request('/frontier',{completenessRevision:1});
    assert.equal(frontier.status,200);
    const polled=await request('/rpc',{jsonrpc:'2.0',id:3,method:'events/poll',
      params:{cursor:'source-v1:0',maxEvents:10}});
    assert.deepEqual(polled.data.result.events.map(x=>x.eventId),['one']);
    const oracleParams={logPath:c.logPath,sourceLog:frontier.data.sourceLog,
      attestation:frontier.data.attestation,
      publicKeyPem:publicPem(k),expected:expected(c),now:Date.now()};
    const oracleFile=join(dir,'oracle-input.json');
    await writeFile(oracleFile,JSON.stringify(oracleParams),{mode:0o600});
    const oracle=spawnSync(process.execPath,
      ['scripts/validation/verify-standalone-oracle-cli.mjs',oracleFile],
      {cwd:process.cwd(),encoding:'utf8',timeout:5000});
    assert.equal(oracle.status,0,oracle.stderr);
    const result=JSON.parse(oracle.stdout.trim());
    assert.equal(result.eventCount,1);
    assert.equal(result.thirdPartyCompletenessCertified,false);
    assert.equal(oracle.stdout.includes(token),false);
    const denied=await request('/control/revocation',{revoked:true});
    assert.equal(denied.status,200);
    const forbidden=await request('/rpc',{jsonrpc:'2.0',id:4,method:'events/poll',params:{cursor:null}});
    assert.equal(forbidden.status,409);
    const old=await request('/frontier',{completenessRevision:1});
    assert.equal(old.status,409);
  }finally{
    if(!exited){child.kill('SIGTERM');await Promise.race([
      once(child,'exit'),new Promise(resolve=>setTimeout(resolve,3000))]);}
    lines.close();if(!exited)child.kill('SIGKILL');
    await rm(dir,{recursive:true,force:true});
  }
});
