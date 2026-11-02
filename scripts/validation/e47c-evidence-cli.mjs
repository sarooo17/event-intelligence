#!/usr/bin/env node
// Read-only. Read pre-existing original artifacts from a trusted local
// directory; never sends HTTP, mutates PostgreSQL, publishes or certifies.
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assessE47CSourceLinkedEvidence} from './e47c-source-linked-evidence.mjs';

async function readPrivateFile(path,maxBytes){
 // O_NOFOLLOW rejects source/host artifacts redirected by symlinks.
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const stat=await handle.stat();
  if(!stat.isFile()||stat.size<1||stat.size>maxBytes)
   throw Error('E47C_UNSAFE_FILE_OR_SIZE');
  const text=await handle.readFile('utf8');
  if(Buffer.byteLength(text)>maxBytes)throw Error('E47C_FILE_GREW_BEYOND_CAP');
  return text;
 }finally{await handle.close();}
}
export async function inspectE47CArtifactDirectory(root){
 const directory=resolve(root);
 const manifest=JSON.parse(await readPrivateFile(join(directory,'manifest.json'),1024*1024));
 const files={};
 const refs=Array.isArray(manifest?.stages)?
  manifest.stages.flatMap(stage=>[stage?.sourceRaw,stage?.hostRaw,stage?.eiRaw]):[];
 if(refs.length>90)throw Error('E47C_ARTIFACT_COUNT_LIMIT');
 for(const ref of refs){
  if(typeof ref?.file!=='string'||
     !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}\.jsonl$/.test(ref.file))
   throw Error('E47C_UNSAFE_ARTIFACT_NAME');
  if(!(ref.file in files))files[ref.file]=await readPrivateFile(join(directory,ref.file),32*1024*1024);
 }
 return assessE47CSourceLinkedEvidence({manifest,files});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const dir=process.argv[2];
 if(!dir||process.argv.length!==3){
  console.error('usage: node scripts/validation/e47c-evidence-cli.mjs <private-raw-artifacts-directory>');
  process.exitCode=2;
 }else{
  try{
   const result=await inspectE47CArtifactDirectory(dir);
   // Only category and counts, NEVER raw source IDs, auth tokens or artifact payload.
   console.log(JSON.stringify(result));
   if(result.status!=='consistent-requires-independent-review')process.exitCode=2;
  }catch(e){
   console.error(JSON.stringify({schema:'ei.e47c.independent-raw-assessment.v1',
    status:'blocked',code:'ARTIFACT_READ_OR_PARSE_FAILED'}));
   process.exitCode=2;
  }
 }
}
