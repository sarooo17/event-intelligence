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
function isLiteral(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
}

function implementedRoutes(source) {
  const ast=ts.createSourceFile('service.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const names=new Set();

  // Inspect every comparison in a condition, not just the first one. This
  // also catches compound GET || HEAD conditions and double-quoted strings.
  function routeCondition(condition) {
    const parts={methods:new Set(),exact:new Set(),prefix:new Set(),suffix:new Set()};
    function visit(node,negated=false) {
      if(ts.isPrefixUnaryExpression(node) &&
        node.operator===ts.SyntaxKind.ExclamationToken) {
        visit(node.operand,!negated);
        return;
      }
      if(ts.isBinaryExpression(node) &&
        node.operatorToken.kind===ts.SyntaxKind.EqualsEqualsEqualsToken) {
        const left=node.left.getText(ast);
        if(left==='request.method' || left==='url.pathname') {
          if(!isLiteral(node.right)) throw new Error('Dynamic HTTP method/path requires explicit route audit');
          if(left==='request.method') parts.methods.add(node.right.text);
          else parts.exact.add(node.right.text);
        }
      }
      if(ts.isCallExpression(node)) {
        const target=node.expression.getText(ast);
        const bucket=target==='url.pathname.startsWith' ? parts.prefix :
          target==='url.pathname.endsWith' && !negated ? parts.suffix : null;
        if(bucket) {
          if(node.arguments.length!==1 || !isLiteral(node.arguments[0])) {
            throw new Error('Dynamic route match requires explicit route audit');
          }
          bucket.add(node.arguments[0].text);
        }
      }
      ts.forEachChild(node,child=>visit(child,negated));
    }
    visit(condition);
    for(const method of parts.methods) {
      for(const exact of parts.exact) names.add(method+' '+exact);
      for(const prefix of parts.prefix) {
        const suffixes=parts.suffix.size ? parts.suffix : new Set(['']);
        for(const suffix of suffixes) names.add(method+' '+prefix+'{id}'+suffix);
      }
    }
  }

  function walk(node) {
    if(ts.isIfStatement(node)) routeCondition(node.expression);
    ts.forEachChild(node,walk);
  }
  walk(ast);
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
    "if (request.method === 'HEAD' && url.pathname === '/readyz') {}",
  ]) {
    assert.notDeepEqual(implementedRoutes(service+'\n'+addition),described,
      'new HTTP route evaded inventory audit: '+addition);
  }
  const compound=service.replace(
    "request.method === 'GET' && url.pathname === '/healthz'",
    "(request.method === 'GET' || request.method === \"HEAD\") && url.pathname === '/healthz'",
  );
  assert.notEqual(compound,service,'compound-method fixture must change service code');
  assert.notDeepEqual(implementedRoutes(compound),described,
    'compound route added a second HTTP method without inventory change');
});

function recognizedCliDispatch(cli) {
  const ast=ts.createSourceFile('cli.mjs',cli,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const positional=new Set(), flags=new Set();
  function walk(node) {
    if(ts.isBinaryExpression(node) &&
      node.operatorToken.kind===ts.SyntaxKind.EqualsEqualsEqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      node.left.expression.getText(ast)==='args' &&
      node.left.argumentExpression?.getText(ast)==='0') {
      if(!isLiteral(node.right)) throw new Error('Dynamic CLI command must be audited');
      positional.add(node.right.text);
    }
    if(ts.isCallExpression(node) && node.expression.getText(ast)==='flags.has') {
      if(node.arguments.length!==1 || !isLiteral(node.arguments[0])) {
        throw new Error('Dynamic CLI flag must be audited');
      }
      flags.add(node.arguments[0].text);
    }
    ts.forEachChild(node,walk);
  }
  walk(ast);
  return {positional:[...positional].sort(),flags:[...flags].sort()};
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
    ['if (args[0] === "export") {}','positional','export'],
    ['if (flags.has("--export")) {}','flags','--export'],
  ]) {
    const found=recognizedCliDispatch(cli+'\n'+suffix);
    assert.equal(found[category].includes(value),true,
      'new CLI dispatcher must be visible to the auditor');
    assert.notDeepEqual(found,expected,'new CLI mode passed closed inventory');
  }
});
