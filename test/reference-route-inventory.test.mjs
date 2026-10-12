import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const read = path => readFileSync(new URL('../'+path,import.meta.url),'utf8');

/**
 * Inspect JavaScript condition expressions from the *real* reference HTTP
 * service, not a copied route registry that might silently diverge. Return
 * method+path only; this intentionally does not declare REST Zod contracts.
 */
function implementedRoutes(source) {
  const ast=ts.createSourceFile('service.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const names=new Set();
  function visit(node) {
    if (ts.isIfStatement(node)) {
      const expr=node.expression.getText(ast);
      const method=expr.match(/request\.method\s*===\s*'([A-Z]+)'/)?.[1];
      if(method) {
        const exact=expr.match(/url\.pathname\s*===\s*'([^']+)'/)?.[1];
        const prefix=expr.match(/url\.pathname\.startsWith\('([^']+)'\)/)?.[1];
        if(exact) {
          names.add(method+' '+exact);
        } else if(prefix) {
          const suffixes=[...expr.matchAll(/(?<!!)url\.pathname\.endsWith\('([^']+)'\)/g)]
            .map(match=>match[1]);
          if(suffixes.length) {
            for(const suffix of suffixes) {
              names.add(method+' '+prefix+'{id}'+suffix);
            }
          } else {
            names.add(method+' '+prefix+'{id}');
          }
        }
      }
    }
    ts.forEachChild(node,visit);
  }
  visit(ast);
  return [...names].sort();
}

test('HTTP reference service route method+path inventory is exhaustive, no unreviewed endpoints',()=>{
  const service=read('scripts/service.mjs');
  const docs=read('docs/REFERENCE-ROUTE-INVENTORY.md');
  const described=[...docs.matchAll(/^\| \`([A-Z]+) (\/[^\`]+)\` \|/gm)]
    .map(([,method,path])=>method+' '+path)
    .sort();
  const routes=implementedRoutes(service);
  assert.equal(routes.length,26,'reference route count changed, audit surface before release');
  assert.equal(new Set(described).size,described.length,
    'duplicate documented reference HTTP route');
  assert.deepEqual(routes,described,'REST service route changed without documentation');
  assert.ok(service.includes("url.pathname.startsWith('/v1/') && !requireBearer("),
    'HTTP reference bearer boundary changed');
  assert.ok(service.includes('verifyGitHubWebhookSignature('),
    'GitHub webhook HMAC verification disappeared');

  // Mutation probes: a new HTTP method or new route on a known verb must
  // invalidate the documented closed route set, not be silently ignored.
  for (const addition of [
    "if (request.method === 'PUT' && url.pathname === '/v1/export') {}",
    "if (request.method === 'POST' && url.pathname === '/v1/new-operation') {}",
  ]) {
    assert.notDeepEqual(implementedRoutes(service+'\\n'+addition),described,
      'new HTTP route evaded inventory audit: '+addition);
  }
});

function recognizedCliDispatch(cli) {
  const positional=[...cli.matchAll(/args\\[0\\]\\s*===\\s*'([^']+)'/g)]
    .map(match=>match[1]);
  const flags=[...cli.matchAll(/flags\\.has\\('([^']+)'\\)/g)]
    .map(match=>match[1]);
  return {positional:[...new Set(positional)].sort(),
    flags:[...new Set(flags)].sort()};
}

test('CLI dispatch inventory rejects new positional commands and flags',()=>{
  const cli=read('bin/mcp-event-intelligence.mjs');
  const docs=read('docs/REFERENCE-ROUTE-INVENTORY.md');
  const expected={
    positional:['doctor','mcp'],
    flags:['--help','--json','--mcp','--version','-h','-v'],
  };
  assert.deepEqual(recognizedCliDispatch(cli),expected);
  for(const token of ['mcp-event-intelligence doctor','mcp-event-intelligence mcp',
    'mcp-event-intelligence --version','mcp-event-intelligence --help']) {
    assert.ok(docs.includes(token),'CLI subcommand undocumented: '+token);
  }
  assert.match(docs,/not a model-facing operation/i);
  for (const [suffix,category,value] of [
    ["if (args[0] === 'export') {}",'positional','export'],
    ["if (flags.has('--export')) {}",'flags','--export'],
  ]) {
    const found=recognizedCliDispatch(cli+'\\n'+suffix);
    assert.equal(found[category].includes(value),true,
      'new CLI dispatcher must be visible to the auditor');
    assert.notDeepEqual(found,expected,'new CLI mode passed closed inventory');
  }
});
