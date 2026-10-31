import {createHash,createPrivateKey,sign as edSign,timingSafeEqual} from 'node:crypto';
import {mkdir,open,readFile,rmdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createServer} from 'node:http';
import {canonicalExternalSourceFrontierClaim,
  SOURCE_FRONTIER_COMPLETENESS_POLICY} from './mcp-source-frontier-attestation.mjs';

const hash=x=>createHash('sha256').update(x).digest('hex');
const initialHash='0'.repeat(64);
const fail=(code,msg)=>Object.assign(new Error(msg),{code});
const iso=ms=>new Date(ms).toISOString();
function requireId(x){if(typeof x!=='string'||!x||x.length>180||
  !/^[a-zA-Z0-9._:-]+$/.test(x))throw fail('SOURCE_ID_INVALID','Invalid source identity');
  return x;}
function parseLog(text){
  if(text.length>16*1024*1024)throw fail('SOURCE_LOG_BUDGET_EXCEEDED','Source log exceeds bounded in-process evidence budget');
  if(text&&!text.endsWith('\n'))throw fail('SOURCE_LOG_TRUNCATED','Unterminated append-only source record');
  const lines=text?text.trimEnd().split('\n'):[];
  const records=[];let prev=initialHash;
  for(const line of lines){
    let r;try{r=JSON.parse(line);}catch{throw fail('SOURCE_LOG_CORRUPTED','Malformed source record');}
    if(!r||r.seq!==records.length+1||r.prev!==prev||
       typeof r.payload!=='object'||Array.isArray(r.payload)||
       r.hash!==hash(r.prev+'\n'+JSON.stringify(r.payload))||
       Object.keys(r).sort().join(',')!=='hash,payload,prev,seq')
      throw fail('SOURCE_LOG_CORRUPTED','Broken source sequence or hash chain');
    prev=r.hash;records.push(r);
  }
  return records;
}
function derive(records){
  const ids=new Map();let lastTime=0,seal=0,activeSeal=0,revision=1,revoked=false;
  for(const row of records){
    const p=row.payload;
    if(p.kind==='event'){
      if(typeof p.eventId!=='string'||!p.eventId||ids.has(p.eventId)||
         typeof p.occurredAt!=='string'||!Number.isFinite(Date.parse(p.occurredAt))||
         Date.parse(p.occurredAt)<=Math.max(lastTime,seal))
        throw fail('SOURCE_LOG_CORRUPTED','Replayed or backdated source event');
      ids.set(p.eventId,row);lastTime=Date.parse(p.occurredAt);
    }else if(p.kind==='seal'){
      const t=Date.parse(p.completeThroughAt);
      if(!Number.isFinite(t)||t<lastTime||t<=seal||p.revision!==revision)
        throw fail('SOURCE_LOG_CORRUPTED','Invalid signed-source seal');
      seal=t;activeSeal=t;
    }else if(p.kind==='availability'){
      if(typeof p.revoked!=='boolean'||p.revoked===revoked||
        p.revision!==revision+1)
        throw fail('SOURCE_LOG_CORRUPTED','Invalid provider revocation transition');
      revision++;revoked=p.revoked;activeSeal=0;
    }else throw fail('SOURCE_LOG_CORRUPTED','Unknown source record kind');
  }
  return {ids,lastTime,seal,activeSeal,revision,revoked,head:records.at(-1)?.hash??initialHash};
}
export async function createStandaloneSource({
  logPath,privateKeyPem,scopeId,sourceKeyDigest,connectionId,
  serverId,eventName,argumentsCanonical='{}',now=()=>Date.now(),
}={}){
  if(typeof logPath!=='string'||!logPath||typeof now!=='function'||
     !/^[a-f0-9]{64}$/.test(sourceKeyDigest??''))
    throw fail('SOURCE_CONFIG_INVALID','Invalid source fixture configuration');
  requireId(scopeId);requireId(connectionId);requireId(serverId);requireId(eventName);
  const key=createPrivateKey(privateKeyPem);
  if(key.asymmetricKeyType!=='ed25519')
    throw fail('SOURCE_CONFIG_INVALID','Ed25519 signing key required');
  await mkdir(dirname(logPath),{recursive:true});
  const lockPath=logPath+'.writer-lock';
  try{await mkdir(lockPath);}catch(e){
    if(e.code==='EEXIST')throw fail('SOURCE_WRITER_LOCKED','Another or unrecovered writer lock exists');
    throw e;
  }
  let records,model,closed=false,serial=Promise.resolve();
  try{records=parseLog(await readFile(logPath,'utf8').catch(e=>{
    if(e.code==='ENOENT')return '';throw e;}));
    model=derive(records);
  }catch(e){await rmdir(lockPath).catch(()=>{});throw e;}
  const queue=fn=>{const next=serial.then(fn);serial=next.catch(()=>{});return next;};
  const add=async payload=>{
    if(closed)throw fail('SOURCE_CLOSED','Source closed');
    const prev=model.head,seq=records.length+1;
    const row={seq,prev,payload,hash:hash(prev+'\n'+JSON.stringify(payload))};
    const file=await open(logPath,'a');
    try{await file.writeFile(JSON.stringify(row)+'\n');await file.sync();}
    finally{await file.close();}
    // Never advance in-memory state before durable file sync; fail closed on
    // subsequent errors rather than continuing after ambiguous writes.
    records.push(row);model=derive(records);return row;
  };
  return {
    eventName,
    async append({eventId,data={}}){
      return queue(async()=>{
        requireId(eventId);
        if(model.revoked)throw fail('SOURCE_REVOKED','Source is revoked');
        if(!data||typeof data!=='object'||Array.isArray(data)||
           Buffer.byteLength(JSON.stringify(data))>16384)
          throw fail('SOURCE_PAYLOAD_INVALID','Source payload too large/invalid');
        const stored=model.ids.get(eventId);
        if(stored){
          if(JSON.stringify(stored.payload.data)!==JSON.stringify(data))
            throw fail('SOURCE_EVENT_ID_CONFLICT','Event id reused with different payload');
          return {accepted:false,sequence:stored.seq,event:stored.payload};
        }
        const current=now();
        if(!Number.isSafeInteger(current)||current<1)
          throw fail('SOURCE_CLOCK_INVALID','Invalid provider clock');
        // Server owns all event timestamps: cannot backdate below the
        // already durable seal, even during backwards wall-clock shifts.
        if(current<=Math.max(model.seal,model.lastTime))
          throw fail('SOURCE_CLOCK_REGRESSION','Provider clock must advance beyond event and seal');
        const payload={kind:'event',eventId,name:eventName,occurredAt:iso(current),data};
        const row=await add(payload);
        return {accepted:true,sequence:row.seq,event:payload};
      });
    },
    async seal(){
      return queue(async()=>{
        if(model.revoked)throw fail('SOURCE_REVOKED','Source is revoked');
        const current=now();
        if(!Number.isSafeInteger(current)||current<model.lastTime||current<=model.seal)
          throw fail('SOURCE_CLOCK_REGRESSION','Provider seal cannot regress');
        const row=await add({kind:'seal',completeThroughAt:iso(current),
          revision:model.revision});
        return {sequence:row.seq,completeThroughAt:iso(current),revision:model.revision,
          head:row.hash};
      });
    },
    async setRevoked(revoked){
      return queue(async()=>{
        if(typeof revoked!=='boolean')throw fail('SOURCE_CONFIG_INVALID','Bad availability');
        if(model.revoked===revoked)return {revision:model.revision,revoked};
        await add({kind:'availability',revoked,revision:model.revision+1});
        return {revision:model.revision,revoked};
      });
    },
    poll({cursor=null,maxEvents=50}={}){
      if(model.revoked)throw fail('SOURCE_REVOKED','Source is revoked');
      if(!Number.isSafeInteger(maxEvents)||maxEvents<1||maxEvents>256)
        throw fail('SOURCE_CURSOR_INVALID','Invalid page limit');
      const start=cursor===null?0:
        /^source-v1:(0|[1-9]\d*)$/.test(cursor??'')?
        Number(cursor.slice('source-v1:'.length)):NaN;
      if(!Number.isSafeInteger(start)||start<0||start>records.length)
        throw fail('SOURCE_CURSOR_INVALID','Unknown/replayed source cursor');
      const events=records.filter(x=>x.seq>start&&x.payload.kind==='event');
      const selected=events.slice(0,maxEvents);
      const end=selected.length===maxEvents?selected.at(-1).seq:records.length;
      return {events:selected.map(r=>({eventId:r.payload.eventId,name:r.payload.name,
        timestamp:r.payload.occurredAt,data:r.payload.data})),
        cursor:'source-v1:'+end,hasMore:events.length>maxEvents,truncated:false,
        nextPollMs:1000,sourceRevision:model.revision};
    },
    frontier({completenessRevision}={}){
      if(model.revoked)throw fail('SOURCE_REVOKED','Source is revoked');
      if(!model.activeSeal)throw fail('SOURCE_UNSEALED','No active durable source seal');
      if(!Number.isSafeInteger(completenessRevision)||completenessRevision<1)
        throw fail('SOURCE_REVISION_INVALID','Host completeness revision required');
      const issuedAtMs=now();
      const claim=canonicalExternalSourceFrontierClaim({
        contract:'ei.external-source-frontier-claim.v1',
        policy:SOURCE_FRONTIER_COMPLETENESS_POLICY,
        scopeDigest:hash(scopeId),sourceKeyDigest,
        argumentsDigest:hash(argumentsCanonical),
        connectionId,serverId,eventName,completenessRevision,
        completeThroughAt:iso(model.activeSeal),issuedAtMs,
        expiresAtMs:issuedAtMs+120000,
      });
      return {attestation:{payload:claim,
        signature:edSign(null,Buffer.from(claim,'utf8'),key).toString('base64url')},
        sourceLog:{sequence:records.length,head:model.head,providerRevision:model.revision}};
    },
    status(){
      return {schema:'ei.standalone-source-status.v1',sequence:records.length,
        head:model.head,revision:model.revision,revoked:model.revoked,
        lastSeal:model.activeSeal?iso(model.activeSeal):null};
    },
    async close(){if(closed)return;closed=true;await serial;await rmdir(lockPath);},
  };
}

export async function serveStandaloneSource({source,token,port=0,host='127.0.0.1'}={}){
  if(!source||typeof token!=='string'||Buffer.byteLength(token)<32)
    throw fail('SOURCE_CONFIG_INVALID','Private source control auth required');
  const unauthorized=(req)=>{
    const expected=Buffer.from('Bearer '+token);
    const provided=Buffer.from(req.headers.authorization??'');
    return provided.length!==expected.length||
      !timingSafeEqual(expected,provided);
  };
  const server=createServer(async(req,res)=>{
    const send=(status,obj)=>{
      res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});
      res.end(JSON.stringify(obj));
    };
    if(req.method==='GET'&&req.url==='/health')
      return send(200,{ok:true,sourceReady:true});
    if(unauthorized(req))return send(401,{error:'unauthorized'});
    if(req.method!=='POST')return send(405,{error:'method-not-allowed'});
    let buffer='';try{
      for await(const chunk of req){
        buffer+=chunk;
        if(Buffer.byteLength(buffer)>32768)throw fail('SOURCE_BODY_LIMIT','Input too large');
      }
      const body=JSON.parse(buffer||'{}');
      if(!body||typeof body!=='object'||Array.isArray(body))
        throw fail('SOURCE_PAYLOAD_INVALID','Invalid request');
      if(req.url==='/rpc'){
        if(body.jsonrpc!=='2.0'||!(typeof body.id==='string'||
          Number.isSafeInteger(body.id))||typeof body.method!=='string')
          throw fail('SOURCE_RPC_INVALID','Invalid JSON-RPC envelope');
        if(body.method==='initialize')return send(200,{
          jsonrpc:'2.0',id:body.id,result:{resultType:'complete',
            protocolVersion:'2026-07-28',
            capabilities:{extensions:{
              'io.modelcontextprotocol/events':{listChanged:false}}},
            serverInfo:{name:'ei-standalone-evidence-source',version:'0.1.0'}}});
        if(body.method==='events/list')return send(200,{
          jsonrpc:'2.0',id:body.id,result:{resultType:'complete',
            events:[{name:source.eventName,description:'Durable test-source log',
              delivery:['poll'],
              inputSchema:{type:'object',additionalProperties:false},
              payloadSchema:{type:'object'}}]}});
        if(body.method==='events/poll')return send(200,{
          jsonrpc:'2.0',id:body.id,result:{...source.poll(body.params),
            resultType:'complete'}});
        return send(200,{jsonrpc:'2.0',id:body.id,error:{
          code:-32601,message:'Method not found'}});
      }
      if(req.url==='/control/append'){
        if(Object.hasOwn(body,'timestamp')||Object.hasOwn(body,'occurredAt'))
          throw fail('SOURCE_BACKDATED_EVENT_REJECTED','Client cannot assign event time');
        return send(200,await source.append(body));
      }
      if(req.url==='/control/seal')return send(200,await source.seal());
      if(req.url==='/control/revocation')return send(200,await source.setRevoked(body.revoked));
      if(req.url==='/frontier')return send(200,source.frontier(body));
      if(req.url==='/status')return send(200,source.status());
      return send(404,{error:'not-found'});
    }catch(e){
      return send(e.code?.startsWith('SOURCE_CLOCK')||e.code==='SOURCE_REVOKED'?409:400,
        {error:e.code??'SOURCE_INVALID_REQUEST'});
    }
  });
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(port,host,ok);});
  return {server,address:server.address(),close:()=>new Promise((resolve,reject)=>
    server.close(e=>e?reject(e):resolve()))};
}
