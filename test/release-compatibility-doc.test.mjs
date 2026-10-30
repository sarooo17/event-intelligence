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
 assert.equal(current.version,'0.12.0-next.0');
 assert.equal(current.postgresSchema,'1');
 assert.equal(current.patternWire,'2');
 assert.equal(current.triggerProtocol,'0.2.0');
 assert.equal(current.triggerSchema,'trigger.v0.2');
 const args=await fixture();
 assert.equal(current.publicExports,Object.keys(args.packageJson.exports).length);
});
test('release documentation fails closed if package version, export map, profile or stored-state marker drifts',async()=>{
 const args=await fixture();
 for(const changed of [
   {...args,packageJson:{...args.packageJson,version:'0.12.0-next.999'}},
   {...args,packageJson:{...args.packageJson,
     exports:{...args.packageJson.exports,'./a-new-export':{import:'./dist/index.js'}}}},
   {...args,doc:args.doc.replace('experimental-extension-2026-09-25','UNKNOWN-MCP-PROFILE')},
   {...args,doc:args.doc.replace('pattern_v2_candidate_signature','missing-signature-component')},
   {...args,doc:args.doc.replace('EVENT_INTELLIGENCE_POSTGRES_SCHEMA_INCOMPATIBLE','redacted')},
   {...args,doc:args.doc.replace('event-intelligence.host-conformance.v2','conformance-old-unknown')},
   {...args,serverJson:{...args.serverJson,version:'1.0.0'}},
 ]){
   assert.throws(()=>checkReleaseCompatibilityDoc(changed),bad);
 }
});
