import { randomUUID } from 'node:crypto';
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
