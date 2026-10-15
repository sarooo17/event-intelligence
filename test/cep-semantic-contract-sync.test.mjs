import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const schema = readFileSync(
  'src/intelligenceProtocol/patternV2Schemas.ts', 'utf8');
const contract = readFileSync(
  'docs/CEP-SEMANTIC-CONTRACT-V2.md', 'utf8');

// Read AST nodes instead of searching TypeScript source text: valid schemas
// may use double quotes, template strings or named string constants.
function schemaKinds(source) {
  const parsed = ts.createSourceFile('patternV2Schemas.ts', source,
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.equal(parsed.parseDiagnostics.length, 0, 'schema must parse');
  // Resolve aliases from their actual lexical block, not a file-wide
  // map keyed only by identifier name. Unrelated functions may declare
  // identical names without changing the canonical schema's binding.
  let root = null;
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) &&
          declaration.name.text === 'PatternNodeV2Schema') {
        assert.equal(root, null, 'canonical schema must have one top-level declaration');
        root = declaration.initializer;
      }
    }
  }
  assert.ok(root, 'canonical schema declaration missing');
  function lexicalDeclaration(identifier) {
    for (let scope = identifier.parent; scope; scope = scope.parent) {
      if (ts.isFunctionLike(scope) && scope.parameters.some(parameter =>
        ts.isIdentifier(parameter.name) &&
        parameter.name.text === identifier.text)) {
        assert.fail('schema alias shadowed by unsupported function parameter: '+identifier.text);
      }
      if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
      const matches = [];
      for (const statement of scope.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) &&
              declaration.name.text === identifier.text) {
            matches.push(declaration);
          }
        }
      }
      if (matches.length > 0) {
        assert.equal(matches.length, 1, 'ambiguous lexical schema binding: '+identifier.text);
        const declaration = matches[0];
        assert.ok(declaration.initializer,
          'schema binding must have a static initializer: '+identifier.text);
        return declaration;
      }
    }
    assert.fail('unresolvable lexical schema alias: '+identifier.text);
  }
  function resolve(node, visiting = new Set()) {
    if (ts.isParenthesizedExpression(node)) return resolve(node.expression, visiting);
    if (ts.isIdentifier(node)) {
      const declaration = lexicalDeclaration(node);
      assert.ok(!visiting.has(declaration), 'cyclic lexical schema alias');
      return resolve(declaration.initializer,
        new Set([...visiting, declaration]));
    }
    return node;
  }
  function method(node,name) {
    return ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'z' &&
      node.expression.name.text === name;
  }
  function literal(node) {
    const value = resolve(node);
    assert.ok(ts.isStringLiteral(value) ||
      ts.isNoSubstitutionTemplateLiteral(value), 'nonliteral discriminator');
    return value.text;
  }
  // The exported z.lazy factory must return the exact union inspected
  // below. A return-level z.union(...) or node.or(...) would otherwise
  // widen the accepted AST without changing the inner named `node`.
  const outer = resolve(root);
  assert.ok(method(outer, 'lazy') && outer.arguments.length === 1,
    'canonical schema must remain one inspectable lazy factory');
  const factory = outer.arguments[0];
  assert.ok(ts.isArrowFunction(factory) && ts.isBlock(factory.body),
    'canonical lazy factory must have a static block body');
  const returns = factory.body.statements.filter(ts.isReturnStatement);
  assert.equal(returns.length, 1,
    'canonical factory must have one inspectable top-level return');
  const returned = returns[0].expression;
  assert.ok(returned && ts.isIdentifier(returned) && returned.text === 'node',
    'factory must return exactly inspected node union; composition needs review');

  // Resolve the actual lexical binding returned by the factory, not
  // an unrelated nested helper's union whose variable is also 'node'.
  const union = resolve(returned);
  assert.ok(method(union,'union') && union.arguments.length === 1,
    'factory returned node must resolve to a statically inspectable z.union');
  const array = resolve(union.arguments[0]);
  assert.ok(ts.isArrayLiteralExpression(array), 'canonical union is not a static array');
  const kinds = [];
  function member(expr) {
    const value = resolve(expr);
    if (method(value,'union')) {
      const inner = resolve(value.arguments[0]);
      assert.ok(ts.isArrayLiteralExpression(inner),'nested union must be static');
      inner.elements.forEach(member);
      return;
    }
    if (method(value,'object')) {
      const shape = resolve(value.arguments[0]);
      assert.ok(ts.isObjectLiteralExpression(shape),'static object shape required');
      const properties = shape.properties.filter(p =>
        ts.isPropertyAssignment(p) &&
        (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
        p.name.text === 'kind');
      assert.equal(properties.length,1,'each union member needs one kind');
      const kind = resolve(properties[0].initializer);
      if(method(kind,'literal')) {
        kinds.push(literal(kind.arguments[0]));
      } else if(method(kind,'enum')) {
        const values=resolve(kind.arguments[0]);
        assert.ok(ts.isArrayLiteralExpression(values),'static z.enum required');
        kinds.push(...values.elements.map(literal));
      } else assert.fail('unsupported discriminator in canonical union');
      return;
    }
    if(ts.isCallExpression(value) &&
      ts.isPropertyAccessExpression(value.expression) &&
      ['strict','superRefine','refine','describe','readonly'].includes(
        value.expression.name.text)) {
      member(value.expression.expression);
      return;
    }
    assert.fail('uninspectable canonical member: '+value.getText(parsed));
  }
  array.elements.forEach(member);
  assert.equal(new Set(kinds).size,kinds.length,'duplicate node discriminator');
  return kinds.sort();
}

test('semantic contract covers every canonical Pattern AST v2 kind exactly once', () => {
  const actual = schemaKinds(schema);
  assert.equal(actual.length, 22,
    'schema kind-count drift requires an explicit conformance review');
  const section = contract.split('## Node contracts')[1]
    ?.split('## Cross-cutting execution contracts')[0];
  assert.ok(section, 'public contract must contain node mapping section');
  const documented = [...section.matchAll(/^\| `([^\`]+)` \|/gm)]
    .map(match => match[1]);
  assert.equal(documented.length, new Set(documented).size,
    'duplicate operator rows would conceal missing coverage');
  assert.deepEqual(documented.sort(), actual,
    'a new/removed AST node must update its public semantic and test category row');
});

test('schema drift detects quotes, constants and externally declared union members', () => {
  const original = schemaKinds(schema);
  const needle = "kind: z.literal('event')";
  assert.deepEqual(schemaKinds(schema.replace(needle,
    'kind: z.literal("event")')),original);
  const constant = schema.replace('export const PatternNodeV2Schema',
    "const NAMED_EVENT_KIND = 'event';\nexport const PatternNodeV2Schema")
    .replace(needle, 'kind: z.literal(NAMED_EVENT_KIND)');
  assert.deepEqual(schemaKinds(constant),original);
  const direct = schema.replace('const node = z.union([',
    'const node = z.union([\n    z.object({ kind: z.literal("new-kind") }),');
  assert.ok(schemaKinds(direct).includes('new-kind'));
  assert.equal(schemaKinds(direct).length,original.length + 1);
  const indirect = schema.replace('const node = z.union([',
    'const ExtraNode = z.object({ kind: z.literal("alias-kind") });\n' +
    '  const node = z.union([\n    ExtraNode,');
  assert.ok(schemaKinds(indirect).includes('alias-kind'));
  assert.equal(schemaKinds(indirect).length,original.length + 1);
  const decorated = indirect.replace('ExtraNode,','ExtraNode.strict(),');
  assert.deepEqual(schemaKinds(decorated),schemaKinds(indirect));

  // Regression: lexical factory-local symbol is not the later unrelated
  // function-local variable of the same name. The old file-wide symbol
  // map would incorrectly report event instead of scope-new-kind.
  const scoped = schema.replace('const node = z.union([',
    "const SHADOWED_KIND = 'scope-new-kind';\n  const node = z.union([")
    .replace(needle,'kind: z.literal(SHADOWED_KIND)') +
    "\nfunction unrelatedShadow() { const SHADOWED_KIND = 'event'; }";
  assert.ok(schemaKinds(scoped).includes('scope-new-kind'),
    'factory-local discriminator must not be overwritten by later unrelated bindings');
  assert.ok(!schemaKinds(scoped).includes('event'),
    'shadowing in another lexical scope cannot hide a new canonical kind');

  // New members attached at the factory's return must fail closed too:
  // inspecting only the inner local `node` would silently miss them.
  const replacement = 'const ExternalNode = z.object({kind:z.literal("outer-kind")});\n' +
    '  return node;';
  const introduced = schema.replace('return node;', replacement);
  assert.notEqual(introduced, schema, 'fixture must mutate factory return');
  assert.throws(() => schemaKinds(introduced.replace('return node;',
    'return node.or(ExternalNode);')), /factory must return exactly/);
  assert.throws(() => schemaKinds(introduced.replace('return node;',
    'return z.union([node, ExternalNode]);')), /factory must return exactly/);

  // A nested helper can contain a legitimate 22-kind union with a local
  // 'node', while the *returned* outer node is a wider composition.
  // The reader must inspect the actual returned declaration, not a
  // convenient same-name declaration found elsewhere in the factory.
  const hidden = schema.replace('  const node = z.union([',
    '  function original() { const node = z.union([')
    .replace('  return node;\n});',
      '    return node; }\n' +
      '  const node = original().or(z.object({kind:z.literal("hidden-kind")}));\n' +
      '  return node;\n});');
  assert.notEqual(hidden,schema,'must create a syntactically changed factory');
  assert.throws(() => schemaKinds(hidden),
    /factory returned node must resolve to a statically inspectable z.union/);
});

test('every operator row declares evidence level and remaining gap', () => {
  const section = contract.split('## Node contracts')[1]
    ?.split('## Cross-cutting execution contracts')[0] ?? '';
  const rows = section.split('\n')
    .filter(line => /^\| `[^\`]+` \|/.test(line));
  assert.equal(rows.length, 22);
  for (const row of rows) {
    assert.match(row, /\| (?:Differential subset|Behavior tests?|Gap): /,
      'each operator needs an honest proof category: ' + row);
    assert.match(row, /\| [^|]+\|$/,
      'each operator must disclose a specific outstanding gap: ' + row);
    const files = [...row.matchAll(/test\/[a-zA-Z0-9-]+\.test\.mjs/g)]
      .map(match => match[0]);
    assert.ok(files.length > 0,'operator must cite a concrete test: '+row);
    for(const file of files) {
      assert.ok(existsSync(file),'nonexistent test evidence: '+file);
    }
  }
});

test('cross-cutting contracts disclose time, partition, budget and host selection boundaries', () => {
  for (const phrase of [
    'allowedLatenessMs', 'maxCandidates', 'maxSemanticEvaluations',
    'truncated:true', 'partitionBy', 'selection.afterMatch',
    'CompositeTriggerEngine', 'onUnavailable:reject',
  ]) {
    assert.ok(contract.includes(phrase),
      'missing mandatory semantic boundary: ' + phrase);
  }
  for (const window of ['within', 'sliding', 'tumbling', 'hopping', 'session', 'count']) {
    assert.ok(contract.includes('`' + window + '`'),
      'missing canonical window variant ' + window);
  }
  assert.match(contract, /not a\s+(?:global )?exactly-once guarantee/);
});
