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
        assert.ok(
          (statement.declarationList.flags & ts.NodeFlags.Const) !== 0,
          'canonical exported schema must be immutable (export const)',
        );
        assert.ok(statement.modifiers?.some(
          modifier => modifier.kind === ts.SyntaxKind.ExportKeyword),
        'canonical exported schema must remain exported',
        );
        root = declaration.initializer;
      }
    }
  }
  assert.ok(root, 'canonical schema declaration missing');
  // Parsing the initializer alone is unsafe if a later assignment replaces
  // the canonical export. TypeScript would reject a write to const anyway,
  // but assert explicitly so the drift detector fails closed on source edits.
  function rejectCanonicalWrites(node) {
    if (ts.isBinaryExpression(node) &&
        ts.isIdentifier(node.left) &&
        node.left.text === 'PatternNodeV2Schema' &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      assert.fail('canonical schema must not be reassigned');
    }
    ts.forEachChild(node, rejectCanonicalWrites);
  }
  rejectCanonicalWrites(parsed);
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
        assert.ok(
          ts.isVariableDeclarationList(declaration.parent) &&
          (declaration.parent.flags & ts.NodeFlags.Const) !== 0,
          'schema alias must be immutable: ' + identifier.text,
        );
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
      // Unlike a primitive const string or Zod object, a const *array*
      // remains mutable. z.union(members) can be widened by members.push()
      // after initialization while an initializer-only walk sees 22 kinds.
      // Require inline arrays for union/enum inputs instead of attempting
      // incomplete data-flow analysis of mutable collection aliases.
      const initializer = declaration.initializer;
      assert.ok(!ts.isArrayLiteralExpression(initializer),
        'schema collection aliases must be inlined (const arrays are mutable)');
      return resolve(initializer,
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
  const returns = [];
  // Fail closed on any conditional/nested return that could widen the
  // accepted AST without altering the final top-level return statement.
  function collectReturns(node) {
    if (ts.isReturnStatement(node)) returns.push(node);
    ts.forEachChild(node, collectReturns);
  }
  collectReturns(factory.body);
  assert.equal(returns.length, 1,
    'canonical factory must contain exactly one return at any nesting depth');
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
    // An aliased Zod schema object is mutable even when its binding is
    // const: e.g. Object.assign(EventNode.shape, { kind: z.literal('x') })
    // changes the runtime union after its initializer. Never claim that
    // inspecting an aliased initializer proves the effective member shape.
    // Keep primitive string aliases in literal() supported separately.
    const unwrapped = ts.isParenthesizedExpression(expr)
      ? expr.expression : expr;
    assert.ok(!ts.isIdentifier(unwrapped),
      'canonical union members must be inline (schema aliases are mutable)');
    const value = resolve(unwrapped);
    if (method(value,'union')) {
      const inner = resolve(value.arguments[0]);
      assert.ok(ts.isArrayLiteralExpression(inner),'nested union must be static');
      inner.elements.forEach(member);
      return;
    }
    if (method(value,'object')) {
      // Resolve only the complete node expression, never its object-shape
      // argument: a `const shape = {...}` alias remains writable via
      // `shape.kind = ...` or Object.assign(shape, ...). Reading only the
      // initializer would certify a stale discriminator. Require a direct
      // literal in z.object, not a mutable shape alias.
      assert.equal(value.arguments.length, 1,
        'canonical z.object must have one inspectable shape');
      const shape = value.arguments[0];
      assert.ok(ts.isObjectLiteralExpression(shape),
        'canonical node shapes must be inline (object aliases are mutable)');
      // An object spread/computed key *after* kind can override its
      // discriminator. Never certify a shape we do not inspect fully.
      for (const property of shape.properties) {
        assert.ok(ts.isPropertyAssignment(property) &&
          (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)),
          'canonical node shape must not use uninspected spreads or computed keys');
      }
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
      // Refinement callbacks run after the surrounding union is created.
      // Capturing the returned "node" can mutate node.options even when
      // the factory itself contains only const declarations and a return.
      // Do not certify wrapper arguments whose callbacks reference the
      // returned union. Inspect AST identifiers (not raw source strings).
      for (const argument of value.arguments) {
        function rejectReturnedUnionCapture(child) {
          if (ts.isIdentifier(child) && child.text === returned.text) {
            assert.fail(
              'canonical member wrapper must not capture returned union');
          }
          // Callback-time eval/Function/globalThis access defeats finite
          // source-AST inspection. Reject the dynamic execution escapes,
          // including indirect eval and computed global constructor paths,
          // rather than trying to interpret arbitrary runtime JS strings.
          if (ts.isIdentifier(child) &&
              ['eval', 'Function', 'globalThis'].includes(child.text)) {
            assert.fail(
              'canonical member wrapper must not use dynamic code execution');
          }
          ts.forEachChild(child, rejectReturnedUnionCapture);
        }
        rejectReturnedUnionCapture(argument);
      }
      member(value.expression.expression);
      return;
    }
    assert.fail('uninspectable canonical member: '+value.getText(parsed));
  }
  array.elements.forEach(member);
  // A returned `const node` is still an object. A post-initialization
  // `node.options.push(...)`, `Object.assign(node,...)` or an indirect
  // const-initializer side effect can widen its runtime union while the
  // initializer-only AST reader still reports the same 22 members.
  // Rather than pretending to solve JS dataflow, accept a deliberately
  // narrow static factory: const union plus primitive string constants,
  // immediately followed by the only, direct return. A refactor outside
  // this subset requires an explicit contract-guard design review.
  assert.equal(factory.body.statements.at(-1), returns[0],
    'canonical lazy factory must end in its direct return');
  for (const statement of factory.body.statements.slice(0, -1)) {
    assert.ok(ts.isVariableStatement(statement) &&
      (statement.declarationList.flags & ts.NodeFlags.Const) !== 0,
      'canonical lazy factory must not contain mutating statements');
    for (const declaration of statement.declarationList.declarations) {
      assert.ok(ts.isIdentifier(declaration.name) && declaration.initializer,
        'canonical lazy factory requires inspectable const declarations');
      if (declaration.name.text === 'node') continue;
      // Primitive string constants cannot have their properties mutated.
      // Whole-schema objects, arrays, calls and arbitrary expressions
      // can mutate the canonical union as hidden side effects.
      const initializer = declaration.initializer;
      assert.ok(ts.isStringLiteral(initializer) ||
        ts.isNoSubstitutionTemplateLiteral(initializer),
        'canonical factory auxiliary declarations must be primitive strings');
    }
  }
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

test('schema drift rejects a spread that can override the kind discriminator', () => {
  const spread = schema.replace(
    "kind: z.literal('event'),",
    "kind: z.literal('event'),\n      ...{ kind: z.literal('surprise-kind') },",
  );
  assert.notEqual(spread,schema);
  assert.throws(() => schemaKinds(spread),
    /canonical node shape must not use uninspected spreads or computed keys/);
  const computed = schema.replace(
    "kind: z.literal('event'),",
    "kind: z.literal('event'),\n      ['kind']: z.literal('computed-kind'),",
  );
  assert.throws(() => schemaKinds(computed),
    /canonical node shape must not use uninspected spreads or computed keys/);
});

test('mutable const whole-schema aliases cannot hide an AST discriminator', () => {
  const literal = `    z.object({
      kind: z.literal('event'),
      ref: Id,
    }).strict(),`;
  const union = '  const node = z.union([';
  assert.ok(schema.includes(literal) && schema.includes(union),
    'fixture must target the canonical inline event and union');
  const aliased = schema.replace(union,
    `  const EventNode: any = z.object({
    kind: z.literal('event'),
    ref: Id,
  }).strict();
  const node = z.union([`)
    .replace(literal, '    EventNode,');
  assert.notEqual(aliased, schema);
  assert.throws(() => schemaKinds(aliased),
    /canonical union members must be inline/,
    'const Zod members are objects and their shapes remain writable');
  const mutated = aliased.replace(union,
    `  Object.assign(EventNode.shape, { kind: z.literal('alias-mutant') });
` + union);
  assert.throws(() => schemaKinds(mutated),
    /canonical union members must be inline/,
    'mutating a referenced Zod schema shape must not bypass drift gate');

  const chained = mutated.replace('    EventNode,', '    EventNode.strict(),');
  assert.throws(() => schemaKinds(chained),
    /canonical union members must be inline/,
    'schema alias wrapped in Zod fluent methods is still mutable');
});

test('mutable const object-shape aliases cannot hide an AST discriminator', () => {
  const original = `    z.object({
      kind: z.literal('event'),
      ref: Id,
    }).strict(),`;
  assert.ok(schema.includes(original),
    'fixture must target the actual canonical event member');

  // An object-valued const is not immutable: this is valid TypeScript and
  // Zod sees the overwritten kind even though its initializer said event.
  const inlineShape = `  const shape: any = {
    kind: z.literal('event'),
    ref: Id,
  };
`;
  const setup = '  const node = z.union([';
  assert.ok(schema.includes(setup));
  const withAlias = schema.replace(setup, inlineShape + setup)
    .replace(original, '    z.object(shape).strict(),');
  assert.notEqual(withAlias, schema);
  assert.throws(() => schemaKinds(withAlias),
    /canonical node shapes must be inline/,
    'shape alias must fail even before an explicit write');

  const assignment = withAlias.replace(setup,
    `  shape.kind = z.literal('property-write-kind');
` + setup);
  assert.throws(() => schemaKinds(assignment),
    /canonical node shapes must be inline/,
    'post-declaration property assignment must not evade drift detection');

  const assigned = withAlias.replace(setup,
    `  Object.assign(shape, { kind: z.literal('object-assign-kind') });
` + setup);
  assert.throws(() => schemaKinds(assigned),
    /canonical node shapes must be inline/,
    'Object.assign must not hide a newly accepted kind');

  const indexed = withAlias.replace(setup,
    `  shape['kind'] = z.literal('computed-write-kind');
` + setup);
  assert.throws(() => schemaKinds(indexed),
    /canonical node shapes must be inline/,
    'computed property writes must not evade the canonical contract');
});

test('refinement callbacks cannot dynamically evaluate schema mutations', () => {
  const needle = `    z.object({
      kind: z.literal('event'),
      ref: Id,
    }).strict(),`;
  assert.ok(schema.includes(needle));
  for(const expression of [
    `eval("node.options.push(z.object({kind:z.literal('evaluated-kind')}))")`,
    `(0,eval)("node.options.push(z.object({kind:z.literal('indirect-eval-kind')}))")`,
    `Function("node", "node.options.push(z.object({kind:z.literal('func-kind')}))")(node)`,
    `globalThis['eval']("node.options.push(z.object({kind:z.literal('global-kind')}))")`,
  ]) {
    const invalid=schema.replace(needle,
      needle.replace('.strict(),',
        `.strict().superRefine(() => { ${expression}; }),`));
    assert.notEqual(invalid,schema);
    assert.throws(() => schemaKinds(invalid),
      /canonical member wrapper must not use dynamic code execution/,
      'dynamic JS evaluation cannot be certified by a static schema audit');
  }
});

test('refinement wrapper callbacks cannot capture and mutate returned union', () => {
  const needle = `    z.object({
      kind: z.literal('event'),
      ref: Id,
    }).strict(),`;
  assert.ok(schema.includes(needle));
  for (const callback of [
    `() => node.options.push(z.object({kind:z.literal('callback-mutant')}))`,
    `(value, ctx) => {
      if (value.ref) Object.assign(node, {
        options: [...node.options, z.object({kind:z.literal('closure-mutant')})],
      });
    }`,
    `() => { const option = node.options; option.push(
      z.object({kind:z.literal('indirect-closure-mutant')})); }`,
  ]) {
    const injected = schema.replace(
      needle,
      needle.replace('.strict(),', `.strict().superRefine(${callback}),`),
    );
    assert.notEqual(injected, schema);
    assert.throws(() => schemaKinds(injected),
      /canonical member wrapper must not capture returned union/,
      'callbacks must not mutate a returned union via closure');
  }
  // Existing legitimate refinements use their own value/context arguments.
  assert.equal(schemaKinds(schema).length, 22);
});

test('returned union cannot be mutated by later factory statements', () => {
  const returned = '  return node;';
  assert.ok(schema.includes(returned));

  const cases = [
    `  node.options.push(z.object({kind: z.literal('hidden-mutant')}));
`,
    `  Object.assign(node, { options: [
    ...node.options, z.object({kind:z.literal('assigned-mutant')})
  ] });
`,
    `  const sideEffect = node.options.push(
    z.object({kind:z.literal('indirect-mutant')}));
`,
    `  if (true) node.options.push(
    z.object({kind:z.literal('conditional-mutant')}));
`,
  ];
  for (const snippet of cases) {
    const widened = schema.replace(returned, snippet + returned);
    assert.notEqual(widened, schema);
    assert.throws(() => schemaKinds(widened),
      /canonical (?:lazy factory must not contain mutating statements|factory auxiliary declarations must be primitive strings)/,
      'post-declaration mutation must not evade the documented operator count');
  }
});

test('mutable canonical export and post-declaration widening fail closed', () => {
  const mutable = schema.replace(
    'export const PatternNodeV2Schema', 'export let PatternNodeV2Schema');
  assert.notEqual(mutable, schema);
  assert.throws(() => schemaKinds(mutable), /canonical exported schema must be immutable/);

  const reassigned = schema + `
PatternNodeV2Schema = PatternNodeV2Schema.or(
  z.object({ kind: z.literal('shadow-new-kind') })
);
`;
  assert.throws(() => schemaKinds(reassigned), /canonical schema must not be reassigned/);
  const writableAndReassigned = mutable + `
PatternNodeV2Schema = PatternNodeV2Schema.or(
  z.object({ kind: z.literal('shadow-new-kind') })
);
`;
  assert.throws(() => schemaKinds(writableAndReassigned),
    /canonical exported schema must be immutable/,
    'valid TypeScript with a mutable exported schema cannot hide a widened runtime kind');
});

test('mutated const union member arrays cannot silently widen canonical schema', () => {
  const literal = '  const node = z.union([';
  const close = '  ]);\n\n  return node;';
  assert.ok(schema.includes(literal) && schema.includes(close));
  const aliased = schema.replace(literal, '  const members: any = [')
    .replace(close, '  ];\n  const node = z.union(members);\n\n  return node;');
  assert.notEqual(aliased, schema);
  assert.throws(() => schemaKinds(aliased),
    /schema collection aliases must be inlined/,
    'even a const array cannot prove immutable member collection');

  const widened = schema.replace(literal, '  const members: any = [')
    .replace(close,
      '  ];\n' +
      '  members.push(z.object({kind:z.literal("injected-kind")}));\n' +
      '  const node = z.union(members);\n\n  return node;');
  assert.notEqual(widened, schema);
  assert.throws(() => schemaKinds(widened),
    /schema collection aliases must be inlined/,
    'a post-initializer .push must not evade the operator contract');
});

test('mutable factory-local aliases cannot widen runtime AST after initialization', () => {
  const mutableAlias = schema
    .replace('const node = z.union([', 'let node: any = z.union([')
    .replace('  return node;', `
  node = node.or(z.object({ kind: z.literal('alias-widened-kind') }));
  return node;`);
  assert.notEqual(mutableAlias, schema);
  assert.throws(() => schemaKinds(mutableAlias),
    /schema alias must be immutable: node/);
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
  assert.throws(() => schemaKinds(indirect),
    /canonical union members must be inline/,
    'a const named Zod node does not guarantee an immutable runtime shape');
  const decorated = indirect.replace('ExtraNode,','ExtraNode.strict(),');
  assert.throws(() => schemaKinds(decorated),
    /canonical union members must be inline/,
    'a method chain on a mutable schema alias cannot bypass the guard');

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
    /factory (?:must contain exactly one return|returned node must resolve to a statically inspectable z.union)/);

  const conditional = schema.replace('  return node;',
    '  if (true) return node.or(z.object({kind:z.literal("conditional-kind")}));\n' +
    '  return node;');
  assert.notEqual(conditional,schema,'conditional fixture must modify factory');
  assert.throws(() => schemaKinds(conditional),
    /factory must contain exactly one return/);
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
