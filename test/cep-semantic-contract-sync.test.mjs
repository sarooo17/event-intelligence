import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const schema = readFileSync(
  'src/intelligenceProtocol/patternV2Schemas.ts', 'utf8');
const contract = readFileSync(
  'docs/CEP-SEMANTIC-CONTRACT-V2.md', 'utf8');

// Read AST nodes instead of searching TypeScript source text: valid schemas
// may use double quotes, template strings or named string constants.
function schemaKinds(source) {
  const parsed = ts.createSourceFile(
    'patternV2Schemas.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = new Map();
  let astDefinition = null;
  function index(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      declarations.set(node.name.text, node.initializer);
      if (node.name.text === 'PatternNodeV2Schema') astDefinition = node.initializer;
    }
    ts.forEachChild(node, index);
  }
  index(parsed);
  assert.ok(astDefinition, 'must locate PatternNodeV2Schema in parsed TypeScript AST');
  function stringLiteral(expr, seen = new Set()) {
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      return expr.text;
    }
    if (ts.isIdentifier(expr)) {
      assert.ok(!seen.has(expr.text), 'recursive AST kind constant');
      const initializer = declarations.get(expr.text);
      assert.ok(initializer, 'unresolved AST kind constant: ' + expr.text);
      return stringLiteral(initializer, new Set([...seen, expr.text]));
    }
    assert.fail('AST kind must be a supported string literal/constant');
  }
  const values = [];
  function read(node) {
    if (ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        node.name.text === 'kind') {
      const call = node.initializer;
      assert.ok(ts.isCallExpression(call) &&
        ts.isPropertyAccessExpression(call.expression) &&
        ts.isIdentifier(call.expression.expression) &&
        call.expression.expression.text === 'z',
      'AST node kind must be a statically readable Zod discriminator');
      const method = call.expression.name.text;
      if (method === 'literal') {
        assert.equal(call.arguments.length, 1);
        values.push(stringLiteral(call.arguments[0]));
      } else if (method === 'enum') {
        const choices = call.arguments[0];
        assert.ok(ts.isArrayLiteralExpression(choices),
          'AST kind union must have static z.enum members');
        values.push(...choices.elements.map(item => stringLiteral(item)));
      } else {
        assert.fail('unsupported AST kind discriminator: z.' + method);
      }
    }
    ts.forEachChild(node, read);
  }
  read(astDefinition);
  assert.equal(values.length, new Set(values).size,
    'duplicate canonical AST discriminants are forbidden');
  return values.sort();
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

test('schema drift detector observes quoted variants and introduced constants', () => {
  const original = schemaKinds(schema);
  const doubleQuoted = schema.replace(
    "kind: z.literal('event')", 'kind: z.literal("event")');
  assert.deepEqual(schemaKinds(doubleQuoted), original,
    'double quoted literals must be interpreted as the same discriminator');

  const constant = schema.replace(
    'export const PatternNodeV2Schema',
    "const NAMED_EVENT_KIND = 'event';\nexport const PatternNodeV2Schema")
    .replace("kind: z.literal('event')", 'kind: z.literal(NAMED_EVENT_KIND)');
  assert.deepEqual(schemaKinds(constant), original,
    'named string literal constants must be followed, not silently ignored');

  const withNewMember = schema.replace(
    'const node = z.union([',
    'const node = z.union([\n    z.object({ kind: z.literal("new-synthetic-kind") }),');
  const augmented = schemaKinds(withNewMember);
  assert.equal(augmented.length, original.length + 1);
  assert.ok(augmented.includes('new-synthetic-kind'),
    'new AST member must fail the published mapping until documented');
});

test('every operator row declares evidence level and remaining gap', () => {
  const section = contract.split('## Node contracts')[1]
    ?.split('## Cross-cutting execution contracts')[0] ?? '';
  const rows = section.split('\n')
    .filter(line => /^\| `[^\`]+` \|/.test(line));
  assert.equal(rows.length, 22);
  for (const row of rows) {
    assert.match(row, /\| (?:Differential subset|Behavior test|Gap): /,
      'each operator needs an honest proof category: ' + row);
    assert.match(row, /\| [^|]+\|$/,
      'each operator must disclose a specific outstanding gap: ' + row);
    assert.match(row, /test\//,
      'each operator must point to at least one concrete test: ' + row);
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
