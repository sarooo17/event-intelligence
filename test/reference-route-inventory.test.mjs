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

const normalizedRouteAccess=text=>{
  let previous;
  do {
    previous=text;
    text=text
      .replace(/request\[(?:'method'|"method")\]/g,'request.method')
      .replace(/url\[(?:'pathname'|"pathname")\]/g,'url.pathname')
      .replace(/\(\s*url\.pathname\s*\)/g,'url.pathname')
      .replace(/\(\s*request\.method\s*\)/g,'request.method');
  } while(text!==previous);
  return text;
};

function implementedRoutes(source) {
  const ast=ts.createSourceFile('service.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const names=new Set();

  function extract(condition) {
    const parts={methods:new Set(),exact:new Set(),prefix:new Set(),suffix:new Set(),negatedSuffix:false};
    function visit(node,negated=false) {
      // An OR between a method-only and a path-only predicate is NOT an
      // HTTP route conjunction. Such a condition can expose broad access.
      if(ts.isBinaryExpression(node) &&
        node.operatorToken.kind===ts.SyntaxKind.BarBarToken) {
        const leftText=normalizedRouteAccess(node.left.getText(ast)),
          rightText=normalizedRouteAccess(node.right.getText(ast));
        const shape=value=>[
          value.includes('request.method'),
          value.includes('url.pathname') &&
            !value.includes('url.pathname.startsWith') &&
            !value.includes('url.pathname.endsWith'),
          value.includes('url.pathname.startsWith'),
          value.includes('url.pathname.endsWith'),
        ];
        const leftShape=shape(leftText), rightShape=shape(rightText);
        if(leftShape.some((kind,index)=>kind!==rightShape[index])) {
          throw new Error('Disjoined HTTP method/path guards require explicit route audit');
        }
      }
      if(ts.isPrefixUnaryExpression(node) &&
        node.operator===ts.SyntaxKind.ExclamationToken) {
        visit(node.operand,!negated);
        return;
      }
      if(ts.isBinaryExpression(node) &&
        [ts.SyntaxKind.ExclamationEqualsEqualsToken,
         ts.SyntaxKind.ExclamationEqualsToken,
         ts.SyntaxKind.EqualsEqualsToken].includes(node.operatorToken.kind) &&
        /(?:request\.method|url\.pathname)/.test(node.getText(ast))) {
        throw new Error('Unsupported HTTP route comparison requires explicit audit');
      }
      if(ts.isBinaryExpression(node) &&
        node.operatorToken.kind===ts.SyntaxKind.EqualsEqualsEqualsToken &&
        [node.left,node.right].some(value=>{
          while(ts.isParenthesizedExpression(value)) value=value.expression;
          return value.kind===ts.SyntaxKind.TrueKeyword ||
            value.kind===ts.SyntaxKind.FalseKeyword;
        }) &&
        /(?:url\.pathname|request\.method)/.test(normalizedRouteAccess(node.getText(ast)))) {
        throw new Error('Boolean-wrapped HTTP matcher requires explicit route audit');
      }
      if(ts.isBinaryExpression(node) &&
        node.operatorToken.kind===ts.SyntaxKind.EqualsEqualsEqualsToken) {
        const unwrap=node=>{
          while(ts.isParenthesizedExpression(node)) node=node.expression;
          return node;
        };
        const left=normalizedRouteAccess(unwrap(node.left).getText(ast));
        const right=normalizedRouteAccess(unwrap(node.right).getText(ast));
        const field=left==='request.method' || left==='url.pathname' ? left :
          right==='request.method' || right==='url.pathname' ? right : null;
        if(field) {
          if(negated) throw new Error('Negated HTTP method/path condition requires explicit route audit');
          const literal=field===left ? node.right : node.left;
          if(!isLiteral(literal)) throw new Error('Dynamic HTTP method/path requires explicit route audit');
          if(field==='request.method') parts.methods.add(literal.text);
          else parts.exact.add(literal.text);
        }
      }
      if(ts.isCallExpression(node)) {
        const target=normalizedRouteAccess(node.expression.getText(ast));
        if(target.startsWith('url.pathname.') &&
           target!=='url.pathname.startsWith' &&
           target!=='url.pathname.endsWith') {
          throw new Error('Unsupported HTTP pathname matcher requires explicit route audit');
        }
        if(target==='url.pathname.endsWith' && negated) parts.negatedSuffix=true;
        const bucket=target==='url.pathname.startsWith' ? parts.prefix :
          target==='url.pathname.endsWith' && !negated ? parts.suffix : null;
        if(bucket) {
          if(negated) throw new Error('Negated HTTP route prefix requires explicit route audit');
          if(node.arguments.length!==1 || !isLiteral(node.arguments[0])) {
            throw new Error('Dynamic route match requires explicit route audit');
          }
          bucket.add(node.arguments[0].text);
        }
      }
      ts.forEachChild(node,child=>visit(child,negated));
    }
    visit(condition);
    if(parts.negatedSuffix && !parts.prefix.size && !parts.exact.size) {
      throw new Error('Negated suffix-only HTTP route requires explicit route audit');
    }
    if(parts.suffix.size && !parts.prefix.size && !parts.exact.size) {
      throw new Error('Suffix-only HTTP route requires explicit route audit');
    }
    const paths=new Set(parts.exact);
    for(const prefix of parts.prefix) {
      const suffixes=parts.suffix.size ? parts.suffix : new Set(['']);
      for(const suffix of suffixes) paths.add(prefix+'{id}'+suffix);
    }
    return {methods:parts.methods,paths};
  }

  // Carry enclosing guards into nested ifs: an HTTP verb and path may be
  // checked in separate nested conditions rather than one flat condition.
  // Do not carry them across sibling/else branches.
  function walk(node,inherited={methods:new Set(),paths:new Set()}) {
    if(ts.isIfStatement(node)) {
      const local=extract(node.expression);
      const methods=local.methods.size ? local.methods : inherited.methods;
      const paths=local.paths.size ? local.paths : inherited.paths;
      for(const method of methods) for(const path of paths) {
        names.add(method+' '+path);
      }
      walk(node.thenStatement,{methods,paths});
      if(node.elseStatement) walk(node.elseStatement,inherited);
      return;
    }
    ts.forEachChild(node,child=>walk(child,inherited));
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
  // This is an exhaustive HTTP method/path inventory test, NOT proof of
  // authentication dominance. Authorization, HMAC and error-path security
  // belong to runtime adversarial tests in #45, not brittle source-position
  // assertions in the #43 operation catalog.
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
  const negatedMethod=service.replace(
    "request.method === 'GET' && url.pathname === '/healthz'",
    "!(request.method === 'GET') && url.pathname === '/healthz'",
  );
  assert.notEqual(negatedMethod,service);
  assert.throws(()=>implementedRoutes(negatedMethod),/Negated HTTP method\/path/,
    'negated method comparison must not be counted as positive');
  const negatedPrefix=service.replace(
    "url.pathname.startsWith('/v1/inspector/triggers/')",
    "!url.pathname.startsWith('/v1/inspector/triggers/')",
  );
  assert.notEqual(negatedPrefix,service);
  assert.throws(()=>implementedRoutes(negatedPrefix),/Negated HTTP route prefix/);
  const disjoined=service.replace(
    "request.method === 'GET' && url.pathname === '/healthz'",
    "request.method === 'GET' || url.pathname === '/healthz'",
  );
  assert.notEqual(disjoined,service);
  assert.throws(()=>implementedRoutes(disjoined),/Disjoined HTTP method\/path guards/);
  const mixedDisjunction=service.replace(
    "request.method === 'GET' && url.pathname === '/healthz'",
    "(request.method === 'GET' && url.pathname === '/healthz') || url.pathname === '/readyz'",
  );
  assert.notEqual(mixedDisjunction,service);
  assert.throws(()=>implementedRoutes(mixedDisjunction),
    /Disjoined HTTP method\/path guards/);
  const unequal=service+"\nif (request.method !== 'HEAD' && url.pathname === '/healthz') {}";
  assert.throws(()=>implementedRoutes(unequal),/Unsupported HTTP route comparison/);
  const bracket=service+"\nif (request['method'] === 'PUT' && url['pathname'] === '/v1/export') {}";
  assert.notDeepEqual(implementedRoutes(bracket),described,
    'bracket notation method/path evaded route inventory');
  const bracketCall=service+"\nif (request['method'] === 'PUT' && url['pathname'].startsWith('/v1/export/')) {}";
  assert.notDeepEqual(implementedRoutes(bracketCall),described,
    'bracket-notation startsWith must be included in the route inventory');
  const unsupportedMatcher=service+"\nif (request.method === 'PUT' && url.pathname.includes('/v1/export')) {}";
  assert.throws(()=>implementedRoutes(unsupportedMatcher),/Unsupported HTTP pathname matcher/,
    'unsupported pathname matcher must fail closed');
  const unsupportedBracketMatcher=service+"\nif (request.method === 'PUT' && url['pathname'].includes('/v1/export')) {}";
  assert.throws(()=>implementedRoutes(unsupportedBracketMatcher),/Unsupported HTTP pathname matcher/);
  const disjoinedMatchers=service+"\nif (request.method === 'POST' && (url.pathname.startsWith('/v1/trigger-matches/') || url.pathname.endsWith('/fire'))) {}";
  assert.throws(()=>implementedRoutes(disjoinedMatchers),
    /Disjoined HTTP method\/path guards/,
    'OR combining unrelated matcher kinds must fail closed');
  const suffixOnly=service+"\nif (request.method === 'PUT' && url.pathname.endsWith('/export')) {}";
  assert.throws(()=>implementedRoutes(suffixOnly),/Suffix-only HTTP route/,
    'suffix-only route must not disappear from inventory');
  const parenthesized=service+"\nif (request.method === 'PUT' && (url.pathname) === '/v1/export') {}";
  assert.notDeepEqual(implementedRoutes(parenthesized),described,
    'parenthesized URL pathname access must be inventoried');
  const parenMatcher=service+"\nif (request.method === 'PUT' && (url.pathname).startsWith('/v1/export/')) {}";
  assert.notDeepEqual(implementedRoutes(parenMatcher),described,
    'parenthesized matcher receiver must be inventoried');
  const negatedSuffixOnly=service+"\nif (request.method === 'PUT' && !url.pathname.endsWith('/export')) {}";
  assert.throws(()=>implementedRoutes(negatedSuffixOnly),/Negated suffix-only HTTP route/,
    'negative suffix without positive prefix/exact anchor must fail closed');
  const booleanWrapped=service+"\nif (request.method === 'PUT' && url.pathname.endsWith('/export') === false) {}";
  assert.throws(()=>implementedRoutes(booleanWrapped),/Boolean-wrapped HTTP matcher/,
    'false-wrapped pathname matcher must fail closed');
  const reversedBoolean=service+"\nif (request.method === 'PUT' && false === url.pathname.endsWith('/export')) {}";
  assert.throws(()=>implementedRoutes(reversedBoolean),/Boolean-wrapped HTTP matcher/,
    'reversed boolean-wrapped pathname matcher must fail closed');
  const negatedMethodBoolean=service+"\nif ((request.method === 'GET') === false && url.pathname === '/healthz') {}";
  assert.throws(()=>implementedRoutes(negatedMethodBoolean),
    /Boolean-wrapped HTTP matcher/,
    'false-wrapped HTTP method check must fail closed');
  const parenthesizedBoolean=service+"\nif ((request.method === 'GET') === ((false)) && url.pathname === '/healthz') {}";
  assert.throws(()=>implementedRoutes(parenthesizedBoolean),/Boolean-wrapped HTTP matcher/,
    'parenthesized false method comparison must fail closed');
  const reversed=service+"\nif ('PUT' === request.method && '/v1/export' === url.pathname) {}";
  assert.notDeepEqual(implementedRoutes(reversed),described,
    'reversed method/path comparison evaded inventory');
  const nested=service+"\nif (request.method === 'POST') { if (url.pathname === '/v1/nested') {} }";
  assert.notDeepEqual(implementedRoutes(nested),described,
    'route built from nested method/path guards escaped the inventory');
});

function recognizedCliDispatch(cli) {
  const ast=ts.createSourceFile('cli.mjs',cli,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const positional=new Set(), flags=new Set();
  function walk(node,negated=false) {
    if(ts.isPrefixUnaryExpression(node) &&
      node.operator===ts.SyntaxKind.ExclamationToken) {
      walk(node.operand,!negated);
      return;
    }
    if(ts.isBinaryExpression(node) &&
      node.operatorToken.kind===ts.SyntaxKind.EqualsEqualsEqualsToken &&
      (ts.isElementAccessExpression(node.left) || ts.isElementAccessExpression(node.right))) {
      const command=ts.isElementAccessExpression(node.left) ? node.left : node.right;
      const literal=command===node.left ? node.right : node.left;
      if(command.expression.getText(ast)==='args' &&
         command.argumentExpression?.getText(ast)==='0') {
        if(negated) throw new Error('Negated CLI dispatcher predicate requires explicit audit');
        if(!isLiteral(literal)) throw new Error('Dynamic CLI command must be audited');
        positional.add(literal.text);
      }
    }
    if(ts.isCallExpression(node) && node.expression.getText(ast)==='flags.has') {
      if(negated) throw new Error('Negated CLI flag predicate requires explicit audit');
      if(node.arguments.length!==1 || !isLiteral(node.arguments[0])) {
        throw new Error('Dynamic CLI flag must be audited');
      }
      flags.add(node.arguments[0].text);
    }
    ts.forEachChild(node,child=>walk(child,negated));
  }
  walk(ast);
  return {positional:[...positional].sort(),flags:[...flags].sort()};
}

test('published package exports are exhaustively classified as non-model library entrypoints',()=>{
  const pkg=JSON.parse(read('package.json'));
  const docs=read('docs/REFERENCE-ROUTE-INVENTORY.md');
  const section=docs.split('## Public library entrypoints')[1]?.split('**Parity check:**')[0];
  assert.ok(section,'missing public library inventory');
  const declared=[...section.matchAll(/^\| \`(mcp-event-intelligence(?:\/[^\`]+)?)\` \|/gm)]
    .map(([,entry])=>entry).sort();
  const expected=Object.keys(pkg.exports).map(key=>
    key==='.'?pkg.name:pkg.name+key.slice(1)).sort();
  assert.equal(new Set(declared).size,declared.length,'duplicate published library entrypoint');
  assert.deepEqual(declared,expected,'package.json exports differ from documented public libraries');
  // Mutation probes: either an additional export or an omitted documented
  // library must break the exact closed inventory.
  const newlyExported=[...expected,'mcp-event-intelligence/unknown'].sort();
  assert.notDeepEqual(declared,newlyExported);
  const missingDocumented=declared.filter(entry=>
    entry!=='mcp-event-intelligence/observability');
  assert.notDeepEqual(missingDocumented,expected);
});

test('CLI dispatch inventory rejects new positional commands and flags',()=>{
  const cli=read('bin/mcp-event-intelligence.mjs');
  const docs=read('docs/REFERENCE-ROUTE-INVENTORY.md');
  const expected={
    positional:['doctor','mcp'],
    flags:['--help','--json','--mcp','--version','-h','-v'],
  };
  assert.deepEqual(recognizedCliDispatch(cli),expected);

  // The no-argument default is not expressed by args[0] or flags.has().
  // Inspect the final else branch of the actual dispatcher, not text in help.
  const ast=ts.createSourceFile('cli.mjs',cli,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const dispatcher=ast.statements.find(statement =>
    ts.isIfStatement(statement) &&
    statement.expression.getText(ast).includes("args[0] === 'doctor'")
  );
  assert.ok(dispatcher,'CLI dispatcher entrypoint missing');
  // The doctor command accepts --json through a separate argument allowlist,
  // NOT through flags.has('--json'). Enforce the admitted option and the
  // fail-closed unknown-option path against the real dispatcher branch.
  const doctorBody=dispatcher.thenStatement.getText(ast);
  const doctorAllowed="args.slice(1).filter((arg) => arg !== '--json')";
  assert.ok(doctorBody.includes(doctorAllowed),
    'doctor accepted-option allowlist drifted from the CLI catalog');
  assert.match(doctorBody,/if\s*\(\s*unrecognized\.length\s*\)/,
    'doctor unknown options must be rejected');
  assert.match(doctorBody,/process\.exitCode\s*=\s*2/,
    'doctor unknown-option branch must return nonzero');
  const alteredDoctor=doctorBody.replace(doctorAllowed,
    "args.slice(1).filter((arg) => arg !== '--format')");
  assert.notEqual(alteredDoctor,doctorBody,'doctor allowlist regression probe did not mutate source');
  assert.equal(alteredDoctor.includes(doctorAllowed),false,
    'doctor allowlist mutation must invalidate the documented --json mode');
  // The flag inventory alone is insufficient: verify each branch's
  // actual dispatch expression, so moving --json into the MCP branch
  // or attaching --mcp to another mode fails before release.
  const compact=node=>node.getText(ast).replace(/\s+/g,'');
  const branches=ast.statements.filter(ts.isIfStatement);
  assert.ok(branches.some(node=>compact(node.expression)===
    "flags.has('--version')||flags.has('-v')"),'version flag dispatch changed');
  assert.ok(branches.some(node=>compact(node.expression)===
    "flags.has('--help')||flags.has('-h')"),'help flag dispatch changed');
  assert.equal(compact(dispatcher.expression),"args[0]==='doctor'",
    'doctor dispatch predicate changed');
  assert.ok(ts.isIfStatement(dispatcher.elseStatement),'MCP dispatcher missing');
  assert.equal(compact(dispatcher.elseStatement.expression),
    "args[0]==='mcp'||flags.has('--mcp')",
    'MCP dispatch or flag target changed');
  const changedMcp=cli.replace(
    "args[0] === 'mcp' || flags.has('--mcp')",
    "args[0] === 'mcp' || flags.has('--mcp') || flags.has('--json')",
  );
  assert.notEqual(changedMcp,cli,'MCP flag-route mutation did not apply');
  const alteredAst=ts.createSourceFile('cli.mjs',changedMcp,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const alteredDispatcher=alteredAst.statements.find(node=>
    ts.isIfStatement(node) && node.expression.getText(alteredAst).includes("args[0] === 'doctor'"));
  assert.ok(alteredDispatcher && ts.isIfStatement(alteredDispatcher.elseStatement));
  assert.notEqual(alteredDispatcher.elseStatement.expression.getText(alteredAst)
    .replace(/\s+/g,''),"args[0]==='mcp'||flags.has('--mcp')",
    'unexpected flag→MCP route must change the validated dispatch contract');
  let finalBranch=dispatcher;
  while(ts.isIfStatement(finalBranch.elseStatement)) finalBranch=finalBranch.elseStatement;
  assert.ok(finalBranch.elseStatement,'missing no-argument default CLI branch');
  assert.match(finalBranch.elseStatement.getText(ast),
    /import\(['"]\.\.\/scripts\/service\.mjs['"]\)/,
    'bare CLI invocation no longer starts the documented reference service');
  // Match complete whitespace-delimited tokens inside backtick code spans.
  // A mere substring would accept "-h" inside "--help" or "-v" inside
  // "--version", giving false confidence that short flags are documented.
  const documentedCommands=[...docs.matchAll(/`([^`]+)`/g)]
    .map(([,command])=>command.trim().split(/\s+/));
  const includesFlag=(text,flag)=>[...text.matchAll(/`([^`]+)`/g)]
    .some(([,command])=>command.trim().split(/\s+/).includes(flag));
  for(const flag of expected.flags) {
    assert.ok(documentedCommands.some(tokens=>tokens.includes(flag)),
      'recognized CLI flag lacks complete documented token: '+flag);
  }
  assert.equal(includesFlag(docs.replace('`-h`',''),'-h'),false,
    'short help flag must not match --help');
  assert.equal(includesFlag(docs.replace('`-v`',''),'-v'),false,
    'short version flag must not match --version');
  const cliTable=docs.split('## CLI entrypoints')[1]?.split('## Public library entrypoints')[0] ?? '';
  const documentedInvocations=[...cliTable.matchAll(/^\| ([^|]+) \|/gm)]
    .slice(2)
    .flatMap(([,cell])=>[...cell.matchAll(/`(mcp-event-intelligence(?:\s+[^\`]+)?)`/g)]
      .map(([,invocation])=>invocation.trim()));
  assert.deepEqual([...documentedInvocations].sort(),[
    'mcp-event-intelligence',
    'mcp-event-intelligence mcp',
    'mcp-event-intelligence doctor',
    'mcp-event-intelligence --version',
    'mcp-event-intelligence --help',
  ].sort(),'CLI documentation must list all complete invocations');
  assert.equal(documentedInvocations.some(value=>value.endsWith('mcpx')),false);
  const changedDocs=docs.replace('`mcp-event-intelligence mcp`','`mcp-event-intelligence mcpx`');
  const changedTable=changedDocs.split('## CLI entrypoints')[1]?.split('## Public library entrypoints')[0] ?? '';
  const changedInvocations=[...changedTable.matchAll(/^\| ([^|]+) \|/gm)]
    .slice(2)
    .flatMap(([,cell])=>[...cell.matchAll(/`(mcp-event-intelligence(?:\s+[^\`]+)?)`/g)]
      .map(([,invocation])=>invocation.trim()));
  assert.notDeepEqual(changedInvocations.sort(),documentedInvocations.sort(),
    'CLI suffix mutation must change complete inventory');
  // Aliases belong to specific command rows, not an arbitrary code span.
  const cliRows=[...cliTable.matchAll(/^\| ([^|]+) \|/gm)].slice(2)
    .map(([,cell])=>cell);
  const rowFor=(invocation)=>cliRows.find(cell=>
    cell.includes('`'+invocation+'`'));
  const exactTokens=(cell)=>[...(cell??'').matchAll(/`([^`]+)`/g)]
    .map(([,token])=>token.trim());
  for(const [invocation,aliases] of [
    ['mcp-event-intelligence',[]],
    ['mcp-event-intelligence mcp',['--mcp']],
    ['mcp-event-intelligence doctor',['--json']],
    ['mcp-event-intelligence --version',['-v']],
    ['mcp-event-intelligence --help',['-h']],
  ]) {
    const tokens=exactTokens(rowFor(invocation));
    const actualAliases=tokens.filter(token=>
      /^--?[a-z]/.test(token) && token!==invocation);
    assert.deepEqual(actualAliases.sort(),[...aliases].sort(),
      `CLI alias set drifted for ${invocation}`);
  }
  const swappedRows=cliTable
    .replace('`--mcp`','`--placeholder`')
    .replace('`--json`','`--mcp`')
    .replace('`--placeholder`','`--json`');
  const alteredMcpRow=[...swappedRows.matchAll(/^\| ([^|]+) \|/gm)]
    .map(([,cell])=>cell)
    .find(cell=>cell.includes('`mcp-event-intelligence mcp`'));
  assert.equal(exactTokens(alteredMcpRow).includes('--mcp'),false,
    'swapping per-row aliases must violate CLI docs contract');
  const bogusAliasRow=cliRows.find(cell=>cell.includes('`mcp-event-intelligence mcp`'))
    .replace('`--mcp`','`--mcp` or `--export`');
  const bogusAliases=exactTokens(bogusAliasRow).filter(token=>/^--?[a-z]/.test(token));
  assert.notDeepEqual(bogusAliases,['--mcp'],
    'extra unsupported aliases must be rejected by exact row set');
  const negatedCli=cli+"\nif (!(args[0] === 'export')) {}";
  assert.throws(()=>recognizedCliDispatch(negatedCli),
    /Negated CLI dispatcher predicate/);
  const negatedFlag=cli+"\nif (!flags.has('--export')) {}";
  assert.throws(()=>recognizedCliDispatch(negatedFlag),
    /Negated CLI flag predicate/);
  const reversedCli=cli+"\nif ('export' === args[0]) {}";
  assert.equal(recognizedCliDispatch(reversedCli).positional.includes('export'),true,
    'reversed CLI comparisons must be detected');

  assert.match(docs,/not additional\s+model-visible operations/i);
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
