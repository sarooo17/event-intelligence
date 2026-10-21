import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rm, lstat, link } from 'node:fs/promises';
import { dirname } from 'node:path';
import { verifyAuditProofWindow } from './audit-proof-window.mjs';

const SCHEMA='event-intelligence.postgres-audit-bundle.v1';
const HASH=/^[0-9a-f]{64}$/;
const MAX_BYTES=64*1024*1024;
const MAX_RECORDS=10000;
function validCheckpoint(cp){
  return !!cp && typeof cp.scopeId==='string' && !!cp.scopeId &&
    Number.isSafeInteger(cp.endSequence) &&
    cp.endSequence>=-1 && cp.endSequence<MAX_RECORDS &&
    (cp.endSequence===-1
      ? cp.firstHash===null && cp.headHash===null
      : HASH.test(cp.firstHash) && HASH.test(cp.headHash));
}
function sameCheckpoint(a,b){
  return validCheckpoint(a) && validCheckpoint(b) &&
    a.scopeId===b.scopeId && a.endSequence===b.endSequence &&
    a.firstHash===b.firstHash && a.headHash===b.headHash;
}
const bounds=(pageSize,maxBytes)=>
  Number.isSafeInteger(pageSize) && pageSize>=1 && pageSize<=1000 &&
  Number.isSafeInteger(maxBytes) && maxBytes>=1024 && maxBytes<=MAX_BYTES;

/** Independent auditor must provide a separately authenticated checkpoint. */
export async function verifyPostgresAuditArchiveBundle(bundle,{
  trustedCheckpoint,
}={}){
  if(!sameCheckpoint(bundle?.checkpoint,trustedCheckpoint) ||
      bundle.schema!==SCHEMA || !Array.isArray(bundle.pages) ||
      !bounds(bundle.pageSize,bundle.maxBytes))return false;
  let seq=-1,hash=null;
  for(const page of bundle.pages){
    if(seq>=trustedCheckpoint.endSequence)return false;
    if(!await verifyAuditProofWindow(page,{
      trustedCheckpoint,trustedAfterSequence:seq,
      trustedPreviousHash:hash,trustedLimit:bundle.pageSize,
    }))return false;
    if(page.endSequence<=seq)return false;
    seq=page.endSequence;
    hash=page.headHash;
  }
  return seq===trustedCheckpoint.endSequence &&
    hash===trustedCheckpoint.headHash;
}

/**
 * Operator-only, POSIX local FS. The output is a durable complete archive,
 * not an independently signed or off-host WORM object, and NOT purge consent.
 */
export async function writePostgresAuditArchiveBundle(store,{
  trustedCheckpoint,outputPath,pageSize=250,maxBytes=MAX_BYTES,
}={}){
  if(!validCheckpoint(trustedCheckpoint) || !bounds(pageSize,maxBytes) ||
      typeof outputPath!=='string' || !outputPath.trim() ||
      typeof store?.getAuditProofWindow!=='function'){
    throw new TypeError('Valid pinned audit checkpoint, outputPath and budgets required');
  }
  try{
    await lstat(outputPath);
    throw new Error('Audit archive destination exists');
  }catch(e){if(e?.code!=='ENOENT')throw e;}
  const staging=outputPath+'.partial-'+randomUUID();
  let fd=null,published=false,bytes=0;
  let seq=-1,hash=null,first=true;
  const add=async segment=>{
    const size=Buffer.byteLength(segment,'utf8');
    if(bytes+size>maxBytes)throw Error('Audit archive byte cap exceeded');
    await fd.writeFile(segment);
    bytes+=size;
  };
  try{
    fd=await open(staging,'wx',0o600);
    await add('{"schema":'+JSON.stringify(SCHEMA)+
      ',"checkpoint":'+JSON.stringify(trustedCheckpoint)+
      ',"pageSize":'+pageSize+',"maxBytes":'+maxBytes+',"pages":[');
    while(seq<trustedCheckpoint.endSequence){
      const page=await store.getAuditProofWindow({
        checkpoint:trustedCheckpoint,afterSequence:seq,limit:pageSize,
      });
      if(!await verifyAuditProofWindow(page,{
        trustedCheckpoint,trustedAfterSequence:seq,
        trustedPreviousHash:hash,trustedLimit:pageSize,
      }) || page.endSequence<=seq){
        throw Error('Invalid audit archive proof page');
      }
      await add((first?'':',')+JSON.stringify(page));
      first=false;seq=page.endSequence;hash=page.headHash;
    }
    if(seq!==trustedCheckpoint.endSequence ||
        hash!==trustedCheckpoint.headHash)throw Error('Incomplete pinned audit');
    await add(']}\n');
    await fd.sync();
    await fd.close();fd=null;
    await link(staging,outputPath);
    published=true;
    await rm(staging);
    const dir=await open(dirname(outputPath),'r');
    try{await dir.sync();}finally{await dir.close();}
    return {outputPath,bytes,endSequence:seq,headHash:hash};
  }catch(error){
    if(published){
      try{
        await rm(outputPath,{force:true});
        const dir=await open(dirname(outputPath),'r');
        try{await dir.sync();}finally{await dir.close();}
      }catch{ /* Return original failure; never claim publication success. */ }
    }
    throw error;
  }finally{
    if(fd)await fd.close();
    await rm(staging,{force:true});
  }
}

export async function verifyPostgresAuditArchiveBundleFile(filePath,{
  trustedCheckpoint,maxBytes=MAX_BYTES,
}={}){
  if(typeof filePath!=='string' || !filePath.trim() ||
      !Number.isSafeInteger(maxBytes) || maxBytes<1024 || maxBytes>MAX_BYTES){
    return false;
  }
  let fd=null;
  try{
    fd=await open(filePath,constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=await fd.stat();
    if(!stat.isFile() || stat.size<2 || stat.size>maxBytes)return false;
    const chunks=[],chunk=Buffer.allocUnsafe(64*1024);
    let length=0;
    while(true){
      const allowance=Math.min(chunk.length,maxBytes+1-length);
      const {bytesRead}=await fd.read(chunk,0,allowance,null);
      length+=bytesRead;
      if(length>maxBytes)return false;
      if(!bytesRead)break;
      chunks.push(Buffer.from(chunk.subarray(0,bytesRead)));
    }
    return verifyPostgresAuditArchiveBundle(
      JSON.parse(Buffer.concat(chunks,length).toString('utf8')),
      {trustedCheckpoint},
    );
  }catch{return false;}
  finally{if(fd)await fd.close();}
}
