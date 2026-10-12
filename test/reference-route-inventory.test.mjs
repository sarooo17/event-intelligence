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
      const method=expr.match(/request\.method\s*===\s*'(GET|POST|PATCH|DELETE)'/)?.[1];
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
  const described=[...docs.matchAll(/^\| \`(GET|POST|PATCH|DELETE) (\/[^\`]+)\` \|/gm)]
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
});

test('CLI exposes only service, stdio MCP, doctor and local informational commands',()=>{
  const cli=read('bin/mcp-event-intelligence.mjs');
  const docs=read('docs/REFERENCE-ROUTE-INVENTORY.md');
  for(const token of ["args[0] === 'doctor'","args[0] === 'mcp'",
    "'--mcp'","'--json'","'--version'","'--help'"]) {
    assert.ok(cli.includes(token),'CLI dispatch changed without contract review: '+token);
  }
  for(const token of ['mcp-event-intelligence doctor','mcp-event-intelligence mcp',
    'mcp-event-intelligence --version','mcp-event-intelligence --help']) {
    assert.ok(docs.includes(token),'CLI subcommand undocumented: '+token);
  }
  assert.match(docs,/not a model-facing operation/i);
});
