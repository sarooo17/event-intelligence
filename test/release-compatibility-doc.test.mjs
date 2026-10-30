import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {
  checkCurrentReleaseCompatibility,checkReleaseCompatibilityDoc,
} from '../scripts/check-release-compatibility-doc.mjs';

async function fixture(){
 const pkg=JSON.parse(await readFile('package.json','utf8'));
 const read=path=>readFile(path,'utf8');
 const [doc,postgresSource,patternSource,triggerSource,hostConformanceSource,serverText]=
   await Promise.all([
     read('docs/releases/'+pkg.version+'-compatibility.md'),
     read('scripts/lib/postgres-event-store.mjs'),
     read('src/intelligenceProtocol/patternV2Schemas.ts'),
     read('src/intelligenceProtocol/triggerSchemas.ts'),
     read('scripts/host-conformance.mjs'),
     read('server.json'),
   ]);
 return {
   packageJson:pkg,serverJson:JSON.parse(serverText),doc,
   postgresSource,patternSource,triggerSource,hostConformanceSource,
 };
}
const bad=e=>e?.code==='EI_RELEASE_COMPATIBILITY_DOC_DRIFT';
test('release documentation matches all current versioned ABI boundaries',async()=>{
 const current=await checkCurrentReleaseCompatibility();
 const args=await fixture();
 assert.equal(current.version,args.packageJson.version);
 assert.equal(current.postgresSchema,
   /POSTGRES_PERSISTED_SCHEMA_VERSION = (\\d+)/.exec(args.postgresSource)?.[1]);
 assert.equal(current.patternWire,
   /PATTERN_AST_VERSION = '([^']+)'/.exec(args.patternSource)?.[1]);
 assert.equal(current.triggerProtocol,
   /COMPOSITE_TRIGGER_PROTOCOL_VERSION = '([^']+)'/.exec(args.triggerSource)?.[1]);
 assert.equal(current.triggerSchema,
   /COMPOSITE_TRIGGER_SCHEMA_VERSION = '([^']+)'/.exec(args.triggerSource)?.[1]);
 assert.equal(current.publicExports,Object.keys(args.packageJson.exports).length);
});
test('release documentation fails closed if package version, export map, profile or stored-state marker drifts',async()=>{
 const args=await fixture();
 for(const changed of [
   {...args,packageJson:{...args.packageJson,version:'0.12.0-next.999'}},
   {...args,packageJson:{...args.packageJson,
     exports:{...args.packageJson.exports,'./a-new-export':{import:'./dist/index.js'}}}},
   {...args,packageJson:{...args.packageJson,
     exports:Object.fromEntries(Object.entries(args.packageJson.exports)
       .filter(([key])=>key!=='./embedded'))}},
   {...args,doc:args.doc.replace('experimental-extension-2026-09-25','UNKNOWN-MCP-PROFILE')},
   {...args,doc:args.doc.replace('pattern_v2_candidate_signature','missing-signature-component')},
   {...args,doc:args.doc.replace('EVENT_INTELLIGENCE_POSTGRES_SCHEMA_INCOMPATIBLE','redacted')},
   {...args,doc:args.doc.replace('event-intelligence.host-conformance.v2','conformance-old-unknown')},
   {...args,serverJson:{...args.serverJson,version:'1.0.0'}},
 ]){
   assert.throws(()=>checkReleaseCompatibilityDoc(changed),bad);
 }
});
test('future correctly updated prerelease is not blocked by a stale test constant',async()=>{
  const args=await fixture();
  const next='0.12.0-next.99';
  const upgraded={...args,
    packageJson:{...args.packageJson,version:next},
    serverJson:{...args.serverJson,version:next,
      packages:args.serverJson.packages.map((p,i)=>i? p:{...p,version:next})},
    doc:args.doc.replaceAll(args.packageJson.version,next)};
  assert.equal(checkReleaseCompatibilityDoc(upgraded).version,next);
});
