import { randomUUID, createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rm, lstat, link } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertAuditJsonNumberPrecision } from './audit-precision-safety.mjs';
import { parseUnambiguousAuditArchiveJson } from './audit-archive-json-integrity.mjs';
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
  trustedCheckpoint,rawArchiveBytes,
}={}){
  // Require the ORIGINAL unparsed artifact, not just a JSON.parse object:
  // JSON.parse can round 9007199254740993 to 9007199254740992 and make a
  // modified audit payload pass existing canonical-hash validation.
  if(!Buffer.isBuffer(rawArchiveBytes) ||
      rawArchiveBytes.length<2 || rawArchiveBytes.length>MAX_BYTES)return false;
  try{
    // Freeze both the original bytes and verified object BEFORE awaiting
    // chained SHA256 checks. Neither caller can mutate the proof in-flight.
    const snapshot=Buffer.from(rawArchiveBytes);
    const {text,parsed}=parseUnambiguousAuditArchiveJson(snapshot);
    assertAuditJsonNumberPrecision(text);
    if(!isDeepStrictEqual(parsed,bundle))return false;
    bundle=parsed;
  }catch{return false;}
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
    const archiveBytes=Buffer.concat(chunks,length);
    return verifyPostgresAuditArchiveBundle(
      parseUnambiguousAuditArchiveJson(archiveBytes).parsed,
      {trustedCheckpoint,rawArchiveBytes:archiveBytes},
    );
  }catch{return false;}
  finally{if(fd)await fd.close();}
}

/**
 * Optional detached Ed25519 witness. Offline key custody and a separately
 * pinned public key are REQUIRED; these helpers are not a WORM writer.
 * Bind exact file BYTES plus complete scope-bound audit checkpoint.
 */
const WITNESS_SCHEMA='event-intelligence.postgres-audit-witness.v1';
const MAX_KEY_ID=128;
const hex=(s)=>typeof s==='string' && /^[0-9a-f]{64}$/.test(s);
const witnessMessage=body=>Buffer.from(JSON.stringify([
  WITNESS_SCHEMA,body.keyId,body.checkpoint.scopeId,
  body.checkpoint.firstHash,body.checkpoint.endSequence,
  body.checkpoint.headHash,body.archiveBytes,body.archiveSha256,
]),'utf8');
const validKeyId=id=>typeof id==='string' &&
  id.length>=1 && id.length<=MAX_KEY_ID &&
  /^[a-zA-Z0-9_.:-]+$/.test(id);
const validBytes=bytes=>Buffer.isBuffer(bytes) &&
  bytes.length>=2 && bytes.length<=MAX_BYTES;
function evidenceBody(bytes,checkpoint,keyId){
  return {
    schema:WITNESS_SCHEMA,keyId,
    checkpoint:{
      scopeId:checkpoint.scopeId,firstHash:checkpoint.firstHash,
      endSequence:checkpoint.endSequence,headHash:checkpoint.headHash,
    },
    archiveBytes:bytes.length,
    archiveSha256:createHash('sha256').update(bytes).digest('hex'),
  };
}
function validateWitness(witness){
  const cp=witness?.checkpoint;
  return witness?.schema===WITNESS_SCHEMA &&
    validKeyId(witness.keyId) && validCheckpoint(cp) &&
    Number.isSafeInteger(witness.archiveBytes) &&
    witness.archiveBytes>=2 && witness.archiveBytes<=MAX_BYTES &&
    hex(witness.archiveSha256) &&
    typeof witness.signature==='string' &&
    /^[A-Za-z0-9+/]{86}==$/.test(witness.signature) &&
    Buffer.from(witness.signature,'base64').length===64;
}
/**
 * Sign only after an independent operator has authenticated its checkpoint.
 * Signing bytes alone does NOT make local storage immutable. Private PEM
 * must be held away from DB / application worker; no key is auto-generated.
 */
export async function signPostgresAuditArchiveWitness({
  archiveBytes,trustedCheckpoint,privateKeyPem,keyId,
}={}){
  if(!validBytes(archiveBytes) || !validCheckpoint(trustedCheckpoint) ||
      !validKeyId(keyId) || typeof privateKeyPem!=='string' ||
      !privateKeyPem.trim()){
    throw new TypeError('Ed25519 audit archive witness requires trusted checkpoint, byte buffer, keyId and private key');
  }
  // The caller's Buffer is mutable. Snapshot synchronously before any
  // asynchronous proof/hash work, and sign ONLY the already-verified bytes.
  const snapshot=Buffer.from(archiveBytes);
  let parsed;
  try{parsed=parseUnambiguousAuditArchiveJson(snapshot).parsed;}
  catch{throw new Error('Invalid or ambiguous signed audit archive content');}
  if(!await verifyPostgresAuditArchiveBundle(parsed,{trustedCheckpoint,rawArchiveBytes:snapshot})){
    throw new Error('Refusing to sign unverified or incomplete audit archive');
  }
  const privateKey=createPrivateKey(privateKeyPem);
  if(privateKey.asymmetricKeyType!=='ed25519'){
    throw new TypeError('Only Ed25519 audit witness private keys accepted');
  }
  const body=evidenceBody(snapshot,trustedCheckpoint,keyId);
  return Object.freeze({...body,
    signature:sign(null,witnessMessage(body),privateKey).toString('base64')});
}

/** Verify file bytes against a separately known Ed25519 public key. */
export async function verifyPostgresAuditArchiveWitness({
  witness,archiveBytes,trustedPublicKeyPem,expectedKeyId,expectedScopeId,
}={}){
  if(!validateWitness(witness) || !validBytes(archiveBytes) ||
      !validKeyId(expectedKeyId) ||
      expectedKeyId!==witness.keyId ||
      typeof expectedScopeId!=='string' || !expectedScopeId ||
      witness.checkpoint.scopeId!==expectedScopeId ||
      typeof trustedPublicKeyPem!=='string' || !trustedPublicKeyPem.trim() ||
      witness.archiveBytes!==archiveBytes.length ||
      createHash('sha256').update(archiveBytes).digest('hex')!==
        witness.archiveSha256)return false;
  try{
    const snapshot=Buffer.from(archiveBytes);
    const publicKey=createPublicKey(trustedPublicKeyPem);
    if(publicKey.asymmetricKeyType!=='ed25519')return false;
    const body=evidenceBody(snapshot,witness.checkpoint,witness.keyId);
    if(!verify(null,witnessMessage(body),publicKey,
      Buffer.from(witness.signature,'base64')))return false;
    return verifyPostgresAuditArchiveBundle(
      parseUnambiguousAuditArchiveJson(snapshot).parsed,
      {trustedCheckpoint:witness.checkpoint,rawArchiveBytes:snapshot},
    );
  }catch{return false;}
}
