import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Frozen, independently checkable Git blob references from merged #355/#356.
// These are whole reference *application adapter modules*, not a selected
// six-line facade region, and are not exported as EI's core SDK.
export const PINNED_REFERENCE_HOST_BLOBS=Object.freeze({
  headless:'eceb4c7db00bae0e14289496508f4644e130676b',
  multiOrg:'df02da9d2f269dd518bbe725ce2de01ac84f5b7d',
});
const PATHS=Object.freeze({
  headless:'examples/host-adapter/headless-job-host.mjs',
  multiOrg:'examples/host-adapter/multi-org-graph-host.mjs',
});

export function gitBlobSha(text){
  if(typeof text!=='string')throw new TypeError('Reference source must be UTF-8 text');
  return createHash('sha1').update('blob '+Buffer.byteLength(text)+'\0')
    .update(text).digest('hex');
}
export function countWholeSource(text){
  if(typeof text!=='string')throw new TypeError('Source must be text');
  const rows=text.replace(/\r\n/g,'\n').split('\n');
  if(rows.at(-1)==='')rows.pop();
  return Object.freeze({
    physical:rows.length,
    nonblank:rows.filter(row=>row.trim().length>0).length,
    bytes:Buffer.byteLength(text),
  });
}
export function readReferenceHostCost({root=process.cwd(),read=readFileSync}={}){
  const results={};
  for(const [profile,path] of Object.entries(PATHS)){
    const contents=read(resolve(root,path),'utf8');
    const blob=gitBlobSha(contents);
    if(blob!==PINNED_REFERENCE_HOST_BLOBS[profile]){
      const e=new Error('HOST_REFERENCE_SOURCE_PIN_MISMATCH: '+profile);
      e.code='HOST_REFERENCE_SOURCE_PIN_MISMATCH';
      throw e;
    }
    // Verify that these hosts use the **public** documented package import,
    // not EI internals or another vendor-specific runtime adapter.
    if(!contents.includes("from 'mcp-event-intelligence/embedded'")||
       /from ['"](?:\.\.\/)+scripts\//.test(contents))
      throw new Error('HOST_REFERENCE_PUBLIC_BOUNDARY_INVALID: '+profile);
    results[profile]=Object.freeze({path,gitBlobSha:blob,
      ...countWholeSource(contents)});
  }
  const manifest=JSON.parse(read(resolve(root,'package.json'),'utf8'));
  if(manifest.exports?.['./embedded']===undefined)
    throw new Error('HOST_REFERENCE_PUBLIC_EXPORT_MISSING');
  return Object.freeze({
    schema:'ei.host-reference-integration-cost.v1',
    candidateVersion:manifest.version,
    fixtureAuthorship:'ei-repository-maintained',
    independentExternalHostVerified:false,
    profiles:results,
    combinedHostAdapterPhysicalLines:
      results.headless.physical+results.multiOrg.physical,
    combinedHostAdapterNonblankLines:
      results.headless.nonblank+results.multiOrg.nonblank,
    newGenericKitRuntimeModules:0,
    newGenericKitRuntimeLOC:0,
    addedEICorePublicExports:0,
    addedEICoreDependencies:0,
    measuredDeveloperHours:null,
    measuredProductionCloudCostUSD:null,
    measuredProductionLatencyP99Ms:null,
    appBeforeAfterComparable:false,
    netIntegrationROIProven:false,
    note:'Reference-host files are new EI-authored example application adapters, not a before/after comparison or a published standalone Host Adapter Kit.',
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{process.stdout.write(JSON.stringify(readReferenceHostCost())+'\n');}
  catch(error){
    console.error(error.code??'EI_HOST_REFERENCE_COST_REPORT_FAILED');
    process.exitCode=1;
  }
}
