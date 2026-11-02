#!/usr/bin/env node
// Read-only. Read pre-existing original artifacts from a trusted local
// directory; never sends HTTP, mutates PostgreSQL, publishes or certifies.
import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assessE47CSourceLinkedEvidence} from './e47c-source-linked-evidence.mjs';

export async function inspectE47CArtifactDirectory(root){
 const directory=resolve(root);
 const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
 const files={};
 const refs=Array.isArray(manifest?.stages)?
  manifest.stages.flatMap(stage=>[stage?.sourceRaw,stage?.hostRaw,stage?.eiRaw]):[];
 if(refs.length>90)throw Error('E47C_ARTIFACT_COUNT_LIMIT');
 for(const ref of refs){
  if(typeof ref?.file!=='string'||
     !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}\.jsonl$/.test(ref.file))
   throw Error('E47C_UNSAFE_ARTIFACT_NAME');
  if(!(ref.file in files))files[ref.file]=await readFile(join(directory,ref.file),'utf8');
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
