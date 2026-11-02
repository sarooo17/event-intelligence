import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const root=process.cwd();
const read=path=>readFile(resolve(root,path),'utf8');
const pages=['AGENTS.md','docs/AI-AGENT-INTEGRATION.md',
  '.agents/skills/event-intelligence-integration/SKILL.md','llms.txt',
  'README.md','docs/README.md','.github/copilot-instructions.md'];

test('portable Agent Skill has discoverable standards-compatible metadata',async()=>{
 const file=await read('.agents/skills/event-intelligence-integration/SKILL.md');
 assert.match(file,/^---\nname: event-intelligence-integration\ndescription: [^\n]{30,1024}\n---\n/);
 assert.match(file,/## Preferred path: host-neutral embedded EI/);
 assert.match(file,/productionSloCertified|production HA\/SLO/);
});
test('all relative Markdown links in new agent pages point to existing paths',async()=>{
 for(const path of pages){
  const text=await read(path);
  const re=/\]\(([^\s)]+)(?:\s+["'][^"']+["'])?\)/g;
  for(const [,url] of text.matchAll(re)){
   if(/^(?:https?:|mailto:|#|app:)/.test(url))continue;
   const target=resolve(root,dirname(path),decodeURIComponent(url.split('#')[0]));
   assert.ok(target.startsWith(root+'/'),path+': path escapes repo '+url);
   await assert.doesNotReject(()=>stat(target),path+' -> '+url);
  }
 }
});
test('documented canonical entry point matches package exports and executable API',async()=>{
 const pkg=JSON.parse(await read('package.json'));
 assert.ok(pkg.exports['./embedded']);
 const api=await import('mcp-event-intelligence/embedded');
 assert.equal(typeof api.createEventIntelligence,'function');
 assert.equal(typeof api.createEmbeddedRuntimeIntegration,'function');
 assert.equal(typeof api.toTriggerPlan,'function');
 const guide=await read('docs/AI-AGENT-INTEGRATION.md');
 assert.match(guide,/createEventIntelligence\(\)/);
 assert.match(guide,/runtimeReceiptId/);
 assert.match(guide,/0\.12\.0-next\.1/);
 assert.match(guide,/already|actual|placeholder/);
});
