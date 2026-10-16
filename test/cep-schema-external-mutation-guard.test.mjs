import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const protectedNames = new Set([
  'PatternNodeV2Schema', 'PatternAstV2DefinitionSchema',
]);
const mutatingMethods = new Set([
  'push','pop','shift','unshift','splice','sort','reverse',
  'set','delete','clear','copyWithin','fill',
]);
const reflectiveMutators = new Set([
  'Object.assign', 'Object.defineProperty', 'Object.defineProperties',
  'Object.setPrototypeOf', 'Reflect.set', 'Reflect.defineProperty',
  'Reflect.setPrototypeOf', 'Reflect.deleteProperty',
]);

function unwrap(expr) {
  let result = expr;
  while(ts.isParenthesizedExpression(result) || ts.isAsExpression(result) ||
    ts.isTypeAssertionExpression(result) || ts.isSatisfiesExpression(result) ||
    ts.isNonNullExpression(result)) result = result.expression;
  return result;
}
function candidates(dir) {
  return readdirSync(dir,{withFileTypes:true})
    .flatMap(entry=>{
      const full=path.join(dir,entry.name);
      return entry.isDirectory()?candidates(full):
        entry.isFile() && full.endsWith('.ts')?[full]:[];
    }).sort();
}

/**
 * Deliberate repository-local guard: prohibits writes through *statically
 * imported* canonical schema values (including assertions, destructuring,
 * namespace imports and property aliases) in source modules. It is not a
 * general-purpose proof of arbitrary dynamic JS code.
 */
function importedSchemaMutations(source,filename) {
  const sf=ts.createSourceFile(filename,source,
    ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  assert.equal(sf.parseDiagnostics.length,0,
    'must parse checked TypeScript file: '+filename);
  const protectedBindings=new Set();
  const namespaces=new Set();

  for(const statement of sf.statements) {
    if(!ts.isImportDeclaration(statement) ||
      !statement.importClause ||
      statement.importClause.isTypeOnly) continue;
    const imp=statement.importClause.namedBindings;
    if(ts.isNamedImports(imp)) {
      for(const element of imp.elements) {
        if(!element.isTypeOnly &&
          protectedNames.has(element.propertyName?.text??element.name.text)) {
          protectedBindings.add(element.name.text);
        }
      }
    } else if(ts.isNamespaceImport(imp)) {
      const moduleName=statement.moduleSpecifier.text;
      if(/(?:patternV2Schemas|intelligenceProtocol|\/index)(?:\.js|\.ts)?$/.test(moduleName)) {
        namespaces.add(imp.name.text);
      }
    }
  }
  const errors=[];
  function aliasesSchema(expr) {
    const node=unwrap(expr);
    if(ts.isIdentifier(node)) return protectedBindings.has(node.text);
    if(ts.isPropertyAccessExpression(node)) {
      if(ts.isIdentifier(node.expression) &&
        namespaces.has(node.expression.text) &&
        protectedNames.has(node.name.text)) return true;
      return aliasesSchema(node.expression);
    }
    if(ts.isElementAccessExpression(node)) {
      if(ts.isIdentifier(node.expression) &&
        namespaces.has(node.expression.text) &&
        (ts.isStringLiteral(node.argumentExpression) ||
          ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)) &&
        protectedNames.has(node.argumentExpression.text)) return true;
      return aliasesSchema(node.expression);
    }
    return false;
  }
  function scan(node) {
    if(ts.isVariableDeclaration(node) && node.initializer &&
      aliasesSchema(node.initializer)) {
      errors.push('schema alias (including destructuring)');
    }
    if(ts.isBinaryExpression(node) &&
      aliasesSchema(node.left) &&
      node.operatorToken.kind>=ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind<=ts.SyntaxKind.LastAssignment) {
      errors.push('schema property assignment');
    }
    if(ts.isDeleteExpression(node) && aliasesSchema(node.expression)) {
      errors.push('schema property deletion');
    }
    if(ts.isCallExpression(node)){
      const expr=unwrap(node.expression);
      if(ts.isPropertyAccessExpression(expr)) {
        if(mutatingMethods.has(expr.name.text) &&
          aliasesSchema(expr.expression)) {
          errors.push('schema mutating method');
        }
        if(ts.isIdentifier(expr.expression) &&
          reflectiveMutators.has(expr.expression.text+'.'+expr.name.text) &&
          node.arguments.length>0 && aliasesSchema(node.arguments[0])) {
          errors.push('schema reflective mutation');
        }
      }
    }
    ts.forEachChild(node,scan);
  }
  scan(sf);
  return {errors,imports:protectedBindings.size+namespaces.size};
}

test('all production imports preserve canonical Zod schema authority',()=>{
  let inspected=0, imports=0;
  const files=candidates('src').filter(x=>
    !x.endsWith('/patternV2Schemas.ts') &&
    !x.endsWith('\\patternV2Schemas.ts'));
  for(const file of files) {
    const source=readFileSync(file,'utf8');
    const result=importedSchemaMutations(source,file);
    inspected++;imports+=result.imports;
    assert.deepEqual(result.errors,[],
      'forbidden cross-module schema mutation in '+file);
  }
  assert.ok(inspected>=20,'must scan production sources, not a single file');
  assert.ok(imports>=1,'at least one canonical schema import must be inspected');
});

test('external alias and property mutation regressions cannot escape guard',()=>{
  const prelude=`import { PatternAstV2DefinitionSchema as Schema }
    from './intelligenceProtocol/patternV2Schemas.js';\n`;
  for(const body of [
    `Object.assign(Schema.shape,{root:other});`,
    `const { shape }:any = Schema; shape.root=other;`,
    `const saved:any=(Schema as any); saved.shape.root=other;`,
    `Schema.shape.root &&= other;`,
    `Reflect.set(Schema.shape,'root',other);`,
    `Schema._def.getter = () => other;`,
  ]) {
    const result=importedSchemaMutations(prelude+body,'synthetic.ts');
    assert.ok(result.errors.length>=1,
      'cross-module mutation must fail closed: '+body);
  }
  const ns=`import * as definitions from './intelligenceProtocol/patternV2Schemas.js';
    (definitions.PatternAstV2DefinitionSchema as any).shape.root=other;`;
  assert.ok(importedSchemaMutations(ns,'synthetic.ts').errors.length>=1);
  const legitimate=prelude+`const data=Schema.parse(input);
    Schema.safeParse(data);`;
  assert.deepEqual(importedSchemaMutations(legitimate,'synthetic.ts').errors,[]);
});
