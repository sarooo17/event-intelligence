import { randomUUID, createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { parseUnambiguousAuditArchiveJson } from './audit-archive-json-integrity.mjs';
import { assertAuditJsonNumberPrecision } from './audit-precision-safety.mjs';
import { constants } from 'node:fs';
import { open, rm, lstat, link } from 'node:fs/promises';
import { dirname } from 'node:path';
import { verifyMcpOccurrenceArchiveWindow, mcpArchiveGenesis } from './mcp-occurrence-archive.mjs';

const BUNDLE_SCHEMA = 'event-intelligence.mcp-occurrence-bundle.v1';
const MAX_BYTES = 64 * 1024 * 1024;
const HASH=/^[0-9a-f]{64}$/;
function validOptions(checkpoint, pageSize, maxBytes) {
  return checkpoint?.schema === 'event-intelligence.mcp-occurrence-archive.v1' &&
    typeof checkpoint.scopeId === 'string' && checkpoint.scopeId.length > 0 &&
    Number.isSafeInteger(checkpoint.endSequence) &&
    checkpoint.endSequence >= 0 && checkpoint.endSequence <= 10000 &&
    HASH.test(checkpoint.headHash) &&
    checkpoint.genesisHash === mcpArchiveGenesis(checkpoint.scopeId) &&
    Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= 1000 &&
    Number.isSafeInteger(maxBytes) && maxBytes >= 1024 && maxBytes <= MAX_BYTES;
}
const checkpointEqual = (a,b) => a && b &&
  a.schema===b.schema && a.scopeId===b.scopeId &&
  a.genesisHash===b.genesisHash && a.endSequence===b.endSequence &&
  a.headHash===b.headHash;

/** Offline trust root comes ONLY from an independently authenticated pin. */
export function verifyMcpOccurrenceArchiveBundle(bundle, {trustedCheckpoint} = {}) {
  if (!checkpointEqual(bundle?.checkpoint,trustedCheckpoint) ||
      bundle?.schema !== BUNDLE_SCHEMA || !Array.isArray(bundle.pages) ||
      !validOptions(trustedCheckpoint, bundle.pageSize, bundle.maxBytes)) return false;
  let after=0,previous=trustedCheckpoint.genesisHash;
  for(const proof of bundle.pages) {
    if(after>=trustedCheckpoint.endSequence) return false;
    if(!verifyMcpOccurrenceArchiveWindow(proof,{
      trustedCheckpoint, trustedAfterSequence:after,
      trustedPreviousHash:previous, trustedLimit:bundle.pageSize,
    }))return false;
    if(proof.endSequence<=after) return false;
    after=proof.endSequence;
    previous=proof.headHash;
  }
  return after===trustedCheckpoint.endSequence &&
    previous===trustedCheckpoint.headHash;
}

/**
 * Operator-owned POSIX local filesystem only. No remote WORM or signatures.
 * Stages a 0600 file, progressively verifies and writes each bounded page,
 * fsyncs file, links into the target exclusively, then fsyncs its directory.
 * The success return happens strictly after the directory entry is durable.
 */
export async function writeMcpOccurrenceArchiveBundle(store,{
  trustedCheckpoint, outputPath, pageSize=250, maxBytes=MAX_BYTES,
}={}) {
  if (!validOptions(trustedCheckpoint,pageSize,maxBytes) ||
      typeof outputPath!=='string' || !outputPath.trim() ||
      typeof store?.getMcpOccurrenceArchiveWindow!=='function') {
    throw new TypeError('Valid external MCP checkpoint, outputPath and archive limits required');
  }
  try {
    await lstat(outputPath);
    throw new Error('MCP archive output path exists; use a fresh path');
  } catch(error) {
    if(error?.code!=='ENOENT')throw error;
  }

  const staging=outputPath+'.partial-'+randomUUID();
  let file=null,published=false;
  let bytes=0,after=0,previous=trustedCheckpoint.genesisHash,first=true;
  const add=async part=>{
    const count=Buffer.byteLength(part,'utf8');
    if(bytes+count>maxBytes) {
      throw new Error('Source archive exceeds byte budget; nothing published');
    }
    await file.writeFile(part);
    bytes+=count;
  };
  try {
    file=await open(staging,'wx',0o600);
    await add('{"schema":'+JSON.stringify(BUNDLE_SCHEMA)+
      ',"checkpoint":'+JSON.stringify(trustedCheckpoint)+
      ',"pageSize":'+pageSize+',"maxBytes":'+maxBytes+',"pages":[');
    while(after<trustedCheckpoint.endSequence) {
      const page=await store.getMcpOccurrenceArchiveWindow({
        checkpoint:trustedCheckpoint,afterSequence:after,
        previousHash:previous,limit:pageSize,
      });
      if(!verifyMcpOccurrenceArchiveWindow(page,{
        trustedCheckpoint,trustedAfterSequence:after,
        trustedPreviousHash:previous,trustedLimit:pageSize,
      }) || page.endSequence<=after) {
        throw new Error('Source archive page failed independent pinned verification');
      }
      // Page memory only. Never collect the entire unbounded source in
      // memory before applying the byte budget.
      await add((first?'':',')+JSON.stringify(page));
      first=false;
      after=page.endSequence;
      previous=page.headHash;
    }
    if(after!==trustedCheckpoint.endSequence ||
        previous!==trustedCheckpoint.headHash) {
      throw new Error('Incomplete source archive cannot be finalized');
    }
    await add(']}\n');
    await file.sync();
    await file.close();file=null;
    await link(staging,outputPath);
    published=true;
    // Remove the staging name BEFORE committing the directory contents:
    // a successful archive must never leave a resurrectable .partial-*
    // artifact after power failure and filesystem journal recovery.
    await rm(staging);
    // fsync the parent directory: an fsync of only the staging file
    // cannot persist the new hard-link name and staging unlink.
    const dir=await open(dirname(outputPath),'r');
    try { await dir.sync(); } finally { await dir.close(); }
    return {outputPath,bytes,endSequence:after,headHash:previous};
  } catch(error) {
    if(published) {
      await rm(outputPath,{force:true});
    }
    throw error;
  } finally {
    if(file) await file.close();
    await rm(staging,{force:true});
  }
}

export async function verifyMcpOccurrenceArchiveBundleFile(filePath,{
  trustedCheckpoint,maxBytes=MAX_BYTES,
}={}) {
  if(typeof filePath!=='string' || !filePath.trim() ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > MAX_BYTES) {
    return false;
  }
  let handle=null;
  try {
    // Open ONCE, disallow symlinks and recheck the size on this same
    // descriptor. Replacements/growth cannot redirect an in-flight read.
    handle=await open(filePath,constants.O_RDONLY|constants.O_NOFOLLOW);
    const info=await handle.stat();
    if(!info.isFile() || info.size>maxBytes || info.size<2) return false;
    const parts=[],chunk=Buffer.allocUnsafe(64*1024);
    let count=0;
    while(true) {
      const allowance=Math.min(chunk.length,maxBytes+1-count);
      const {bytesRead}=await handle.read(chunk,0,allowance,null);
      count+=bytesRead;
      if(count>maxBytes)return false;
      if(bytesRead===0) break;
      parts.push(Buffer.from(chunk.subarray(0,bytesRead)));
    }
    const bundle=JSON.parse(Buffer.concat(parts,count).toString('utf8'));
    return verifyMcpOccurrenceArchiveBundle(bundle,{trustedCheckpoint});
  } catch {
    return false;
  } finally {
    if(handle)await handle.close();
  }
}

/**
 * Bounded OFFLINE replay window from an authenticated immutable logical
 * prefix. Exposes the ORIGINAL PostgreSQL JSONB text, not parsed JS event
 * numbers; this preserves large/precise numeric lexemes losslessly.
 *
 * This is intentionally not a runtime fallback: providers, CEP state,
 * subscriptions and host wake safety still need an audited cutover before
 * an archived prefix may ever be physically removed from PostgreSQL.
 */
export function readMcpOccurrenceArchiveReplayWindow(bundle,{
  trustedCheckpoint,afterSequence=0,limit=100,
}={}){
  if(!Number.isSafeInteger(afterSequence) || afterSequence<0 ||
      !Number.isSafeInteger(limit) || limit<1 || limit>1000 ||
      !Number.isSafeInteger(trustedCheckpoint?.endSequence) ||
      afterSequence>trustedCheckpoint.endSequence){
    const err=new TypeError('Offline MCP archive replay needs valid trusted checkpoint and bounded cursor');
    err.code='EVENT_INTELLIGENCE_MCP_ARCHIVE_REPLAY_POLICY_INVALID';
    throw err;
  }
  if(!verifyMcpOccurrenceArchiveBundle(bundle,{trustedCheckpoint})){
    const err=new Error('Offline MCP archive replay rejected unverified occurrence prefix');
    err.code='EVENT_INTELLIGENCE_MCP_ARCHIVE_REPLAY_UNTRUSTED';
    throw err;
  }
  const records=[];
  let seq=0;
  for(const page of bundle.pages){
    for(const rawPayloadJson of page.records){
      seq++;
      if(seq>afterSequence && records.length<limit){
        records.push(Object.freeze({sequence:seq,rawPayloadJson}));
      }
    }
  }
  const endSequence=afterSequence+records.length;
  return Object.freeze({
    schema:'event-intelligence.mcp-occurrence-archive-replay.v1',
    scopeId:trustedCheckpoint.scopeId,afterSequence,limit,
    endSequence,hasMore:endSequence<trustedCheckpoint.endSequence,
    records:Object.freeze(records),
  });
}

/**
 * Detached signed SOURCE witness (#47). Neither this signature nor local
 * archive export proves off-host WORM retention or permits physical TTL.
 * An independent operator pins the FULL checkpoint, expected signing key ID,
 * expected tenant and Ed25519 public key outside the database/archive.
 */
const SOURCE_WITNESS_SCHEMA = 'event-intelligence.mcp-occurrence-witness.v1';
const sourceWitnessKeys = Object.freeze([
  'archiveBytes','archiveSha256','checkpoint','keyId','schema','signature',
]);
const sourceCheckpointKeys = Object.freeze([
  'endSequence','genesisHash','headHash','schema','scopeId',
]);
const exactKeys=(obj,keys)=>obj && typeof obj==='object' &&
  !Array.isArray(obj) && Object.keys(obj).sort().join(',')===keys.join(',');
const validSourceKeyId=id=>typeof id==='string' &&
  id.length>=1 && id.length<=128 && /^[A-Za-z0-9_.:-]+$/.test(id);
const validSourceBytes=bytes=>Buffer.isBuffer(bytes) &&
  bytes.length>=2 && bytes.length<=MAX_BYTES;
const sourceDigest=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceWitnessMessage=body=>Buffer.from(JSON.stringify([
  SOURCE_WITNESS_SCHEMA,body.keyId,body.checkpoint.schema,
  body.checkpoint.scopeId,body.checkpoint.genesisHash,
  body.checkpoint.endSequence,body.checkpoint.headHash,
  body.archiveBytes,body.archiveSha256,
]),'utf8');
const sourceWitnessBody=(bytes,checkpoint,keyId)=>({
  schema:SOURCE_WITNESS_SCHEMA,
  keyId,
  checkpoint:Object.freeze({
    schema:checkpoint.schema,scopeId:checkpoint.scopeId,
    genesisHash:checkpoint.genesisHash,endSequence:checkpoint.endSequence,
    headHash:checkpoint.headHash,
  }),
  archiveBytes:bytes.length,
  archiveSha256:sourceDigest(bytes),
});
function parseStrictSourceArchive(bytes){
  const result=parseUnambiguousAuditArchiveJson(bytes);
  // The outer archive uses safe integer sequence/count metadata. The
  // original arbitrary-precision PG JSONB payloads remain opaque strings.
  assertAuditJsonNumberPrecision(result.text);
  return result.parsed;
}

/**
 * Sign exact bytes ONLY after verifying the WHOLE source archive against an
 * independently authenticated checkpoint. No private key is auto-generated,
 * loaded from a DB or written alongside this artifact.
 */
export async function signMcpOccurrenceArchiveWitness({
  archiveBytes,trustedCheckpoint,privateKeyPem,keyId,
}={}){
  if(!validSourceBytes(archiveBytes) ||
      !exactKeys(trustedCheckpoint,sourceCheckpointKeys) ||
      !validOptions(trustedCheckpoint,1,1024) ||
      !validSourceKeyId(keyId) ||
      typeof privateKeyPem!=='string' || !privateKeyPem.trim()){
    throw new TypeError('Signed source witness requires exact archive bytes, independently trusted full checkpoint, key ID and Ed25519 private key');
  }
  // Copy synchronously: callers may mutate their Buffer during async calls.
  const snapshot=Buffer.from(archiveBytes);
  let archive;
  try{archive=parseStrictSourceArchive(snapshot);}
  catch{throw new Error('Refusing ambiguous, malformed or unsafe source archive bytes');}
  if(!verifyMcpOccurrenceArchiveBundle(archive,{trustedCheckpoint})){
    throw new Error('Refusing to sign incomplete or untrusted source archive');
  }
  const key=createPrivateKey(privateKeyPem);
  if(key.asymmetricKeyType!=='ed25519'){
    throw new TypeError('Source archive witness only accepts Ed25519 private keys');
  }
  const body=sourceWitnessBody(snapshot,trustedCheckpoint,keyId);
  return Object.freeze({
    ...body,signature:sign(null,sourceWitnessMessage(body),key).toString('base64'),
  });
}

/**
 * Separate trusted full checkpoint is mandatory even with a valid signature:
 * this prevents accepting an old legitimate signed prefix as a fresh one.
 * Exact original archive bytes, not JSON.parse/stringify substitutes.
 */
export async function verifyMcpOccurrenceArchiveWitness({
  witness,archiveBytes,trustedCheckpoint,
  trustedPublicKeyPem,expectedKeyId,expectedScopeId,
}={}){
  if(!exactKeys(witness,sourceWitnessKeys) ||
      witness.schema!==SOURCE_WITNESS_SCHEMA ||
      !exactKeys(witness.checkpoint,sourceCheckpointKeys) ||
      !exactKeys(trustedCheckpoint,sourceCheckpointKeys) ||
      !validOptions(trustedCheckpoint,1,1024) ||
      !checkpointEqual(witness.checkpoint,trustedCheckpoint) ||
      !validSourceKeyId(expectedKeyId) ||
      witness.keyId!==expectedKeyId ||
      typeof expectedScopeId!=='string' || !expectedScopeId ||
      witness.checkpoint.scopeId!==expectedScopeId ||
      typeof trustedPublicKeyPem!=='string' || !trustedPublicKeyPem.trim() ||
      !validSourceBytes(archiveBytes) ||
      !Number.isSafeInteger(witness.archiveBytes) ||
      witness.archiveBytes!==archiveBytes.length ||
      !HASH.test(witness.archiveSha256) ||
      typeof witness.signature!=='string' ||
      !/^[A-Za-z0-9+/]{86}==$/.test(witness.signature))return false;
  const snapshot=Buffer.from(archiveBytes);
  if(sourceDigest(snapshot)!==witness.archiveSha256)return false;
  try{
    const key=createPublicKey(trustedPublicKeyPem);
    if(key.asymmetricKeyType!=='ed25519')return false;
    const signature=Buffer.from(witness.signature,'base64');
    if(signature.length!==64)return false;
    const body=sourceWitnessBody(snapshot,trustedCheckpoint,expectedKeyId);
    if(!verify(null,sourceWitnessMessage(body),key,signature))return false;
    return verifyMcpOccurrenceArchiveBundle(
      parseStrictSourceArchive(snapshot),{trustedCheckpoint});
  }catch{return false;}
}
