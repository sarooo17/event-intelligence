#!/usr/bin/env node
// Release candidate compatibility assertions: documentation is itself a
// release interface. Fail CI if the public contract changes without updating
// a *versioned* manifest, migration instructions and supported profile list.
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {
  DEFAULT_MCP_EVENTS_COMPATIBILITY_PROFILE,
} from './lib/mcp-events-compatibility.mjs';
import {
  PATTERN_V2_SIGNATURE_CONTRACT_VERSION,
  PATTERN_V2_SIGNATURE_COMPONENT,
} from './lib/pattern-v2-signature-contract.mjs';

const contains=(text,value,label,missing)=>{
  if(!text.includes(value))missing.push(label+': '+value);
};
function matchSource(text,regexp,label){
  const value=regexp.exec(text)?.[1];
  if(!value)throw new Error('Cannot inspect source contract '+label);
  return value;
}

export function checkReleaseCompatibilityDoc({
  packageJson,serverJson,doc,postgresSource,patternSource,
  triggerSource,hostConformanceSource,engineMinimum,
  mcpProfile=DEFAULT_MCP_EVENTS_COMPATIBILITY_PROFILE,
}={}){
  const pkg=typeof packageJson==='string'?JSON.parse(packageJson):packageJson;
  const server=typeof serverJson==='string'?JSON.parse(serverJson):serverJson;
  if(!pkg||!server||typeof doc!=='string'||
     typeof postgresSource!=='string'||typeof patternSource!=='string'||
     typeof triggerSource!=='string'||typeof hostConformanceSource!=='string')
    throw new TypeError('Release compatibility check requires all source contracts');
  const missing=[];
  const target=Number(engineMinimum??pkg.engines?.node?.match(/\d+/)?.[0]);
  if(!Number.isSafeInteger(target))
    throw new Error('Cannot determine Node engine minimum');
  const pgSchema=matchSource(postgresSource,
    /export const POSTGRES_PERSISTED_SCHEMA_VERSION = (\d+)/,
    'Postgres store schema');
  const patternWire=matchSource(patternSource,
    /export const PATTERN_AST_VERSION = '([^']+)'/,
    'Pattern wire');
  const triggerProtocol=matchSource(triggerSource,
    /export const COMPOSITE_TRIGGER_PROTOCOL_VERSION = '([^']+)'/,
    'Trigger protocol');
  const triggerSchema=matchSource(triggerSource,
    /export const COMPOSITE_TRIGGER_SCHEMA_VERSION = '([^']+)'/,
    'Trigger schema');
  if(server.version!==pkg.version||
     server.packages?.[0]?.version!==pkg.version)
    missing.push('package / MCP Registry version mismatch');
  contains(doc,pkg.version,'candidate release version',missing);
  contains(doc,'>='+target,'Node support',missing);
  contains(doc,'@modelcontextprotocol/server@'+pkg.dependencies?.['@modelcontextprotocol/server'],
    'MCP SDK support',missing);
  contains(doc,'pg@'+pkg.dependencies?.pg,'PG driver',missing);
  contains(doc,mcpProfile,'MCP Events provider profile',missing);
  contains(doc,triggerProtocol,'trigger protocol',missing);
  contains(doc,triggerSchema,'trigger schema',missing);
  contains(doc,'version: "'+patternWire+'"','Pattern wire schema',missing);
  contains(doc,'POSTGRES_PERSISTED_SCHEMA_VERSION = '+pgSchema,
    'persisted store schema',missing);
  contains(doc,PATTERN_V2_SIGNATURE_COMPONENT,'candidate signature component',missing);
  contains(doc,'version '+PATTERN_V2_SIGNATURE_CONTRACT_VERSION,
    'candidate signature version',missing);
  for(const name of Object.keys(pkg.exports??{}))
    contains(doc,'`'+name+'`','npm export',missing);
  for(const term of [
    'authorize()','AuthorizationDecision',
    'control(request)','event-intelligence.host-conformance.v2',
    'v3','EVENT_INTELLIGENCE_PATTERN_V2_SIGNATURE_INCOMPATIBLE',
    'EVENT_INTELLIGENCE_POSTGRES_SCHEMA_INCOMPATIBLE',
    'EVENT_INTELLIGENCE_POSTGRES_SCHEMA_SHAPE_INVALID',
    'MCP_EVENTS_PROFILE_UNKNOWN',
    'snapshot','rollback',
    'mixed fenced/unfenced',
    'production-certified',
    'not supported',
    'No legacy',
  ]){
    // Some support-boundary phrases may appear with different word case;
    // require a discrete clear disclaimer rather than implied compatibility.
    if(!doc.toLowerCase().includes(term.toLowerCase()))
      missing.push('release-compatibility critical section: '+term);
  }
  if(!hostConformanceSource.includes('event-intelligence.host-conformance.v3'))
    missing.push('unexpected host conformance source ABI');
  if(missing.length){
    const e=new Error('Release compatibility documentation drift: '+missing.join(' | '));
    e.code='EI_RELEASE_COMPATIBILITY_DOC_DRIFT';
    throw e;
  }
  return {contract:'ei.release-compatibility-doc.v1',
    version:pkg.version,publicExports:Object.keys(pkg.exports).length,
    postgresSchema:pgSchema,patternWire,triggerSchema,triggerProtocol};
}

export async function checkCurrentReleaseCompatibility({
  root=process.cwd(),
}={}){
  const read=path=>readFile(resolve(root,path),'utf8');
  const [p,s,pg,pattern,trigger,host]=await Promise.all([
    read('package.json'),read('server.json'),
    read('scripts/lib/postgres-event-store.mjs'),
    read('src/intelligenceProtocol/patternV2Schemas.ts'),
    read('src/intelligenceProtocol/triggerSchemas.ts'),
    read('scripts/host-conformance.mjs'),
  ]);
  const pkg=JSON.parse(p);
  const doc=await read('docs/releases/'+pkg.version+'-compatibility.md');
  return checkReleaseCompatibilityDoc({
    packageJson:pkg,serverJson:JSON.parse(s),doc,
    postgresSource:pg,patternSource:pattern,triggerSource:trigger,
    hostConformanceSource:host,
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const result=await checkCurrentReleaseCompatibility();
    console.log(JSON.stringify(result));}
  catch(e){console.error(e.code??'EI_RELEASE_COMPATIBILITY_DOC_INVALID');
    process.exitCode=1;}
}
