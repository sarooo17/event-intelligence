// Bounded mutation test of the compiled production Pattern v2 evaluator.
// A mutation must load, evaluate successfully, and yield a *wrong result*
// according to an independent, finite oracle to count as killed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const seed = 20261015;
const clockOrigin = Date.UTC(2026, 9, 15, 12, 0, 0);
const root = process.cwd();
const compiled = join(root, 'dist', 'src');
const evaluatorFile = join('patternV2', 'evaluator.js');
const hash = data => createHash('sha256').update(data).digest('hex');

function occurrence(ref, id, ms) {
  return {
    clauseId: ref,
    sourceEventId: id,
    traceId: 'production-mutant:' + id,
    eventName: ref + '.event',
    occurredAt: new Date(clockOrigin + ms).toISOString(),
    provider: 'finite-oracle',
    serverId: 'mutation-conformance',
    subscriptionArguments: {},
    data: {},
  };
}
function definition(rootNode, maxCandidates, buffered=64) {
  return {
    version: '2', root: rootNode, partitionBy: [],
    selection: { overlap: 'allow', afterMatch: 'keepAll',
      maxMatchesPerEvent: 100 },
    execution: { maxCandidates, maxSemanticEvaluations: 0,
      maxBufferedEvents: buffered },
  };
}
const cases = {
  event_limit: {
    definition: definition({kind:'event',ref:'x'}, 2),
    events: [occurrence('x','x:0',0),occurrence('x','x:1',100),
      occurrence('x','x:2',200)],
    now: new Date(clockOrigin + 500),
    expected: {matches:['x:0','x:1'],pending:[],truncated:true},
  },
  allof_join_limit: {
    definition: definition({kind:'allOf',children:[
      {kind:'event',ref:'a'}, {kind:'event',ref:'b'},
    ]}, 2),
    events: [occurrence('a','a:0',0),occurrence('a','a:1',100),
      occurrence('b','b:0',200),occurrence('b','b:1',300)],
    now: new Date(clockOrigin + 500),
    expected: {matches:['a:0|b:0','a:0|b:1'],pending:[],truncated:true},
  },
  forbidden_inclusive_deadline: {
    definition: definition({kind:'notFollowedBy',id:'forbidden-deadline',
      child:{kind:'event',ref:'a'},forbidden:{kind:'event',ref:'b'},
      withinMs:400}, 8),
    events: [occurrence('a','a:0',0),occurrence('b','b:deadline',400)],
    now: new Date(clockOrigin + 550),
    allowedLatenessMs:100,
    expected: {matches:[],pending:[],truncated:false},
  },
};

// These are literal compiled-JS mutations, not mock evaluators or
// modifications to an independent reference oracle.
const mutants = [
  {
    id: 'event_limit_off_by_one',
    fixture: 'event_limit',
    find: 'if (values.length >= context.maxCandidates) {',
    replace: 'if (values.length > context.maxCandidates) {',
  },
  {
    id: 'allof_dropped_truncation',
    fixture: 'allof_join_limit',
    find: 'context.truncated ||= truncated;',
    replace: 'context.truncated ||= false;',
  },
  {
    id: 'negative_forbidden_deadline_exclusive',
    fixture: 'forbidden_inclusive_deadline',
    find: 'completedAt <= dueAt',
    replace: 'completedAt < dueAt',
  },
];
export const MUTATION_CORPUS_VERSION = 'ei.cep-production-mutation.v1';

function shuffle(original, id) {
  const events = [...original];
  let value = (seed ^ Math.imul(id, 0x9e3779b1)) >>> 0;
  for(let i=events.length-1;i>0;i--) {
    value = (Math.imul(value,1664525)+1013904223) >>> 0;
    const j=value%(i+1);
    [events[i],events[j]]=[events[j],events[i]];
  }
  return events;
}
function projection(result) {
  const ids = candidates=>candidates.map(candidate=>
    candidate.events.map(event=>event.sourceEventId).join('|')).sort();
  return {
    matches: ids(result.matches),
    pending: ids(result.pending),
    truncated: result.truncated,
  };
}
async function runCase(evaluatePatternV2, item, round) {
  const result = await evaluatePatternV2({
    definition:item.definition,
    events:shuffle(item.events,round),
    now:item.now,
    allowedLatenessMs:item.allowedLatenessMs??0,
  });
  return projection(result);
}

export async function runMutationCorpus() {
  const originalPath=join(compiled,evaluatorFile);
  const original=await readFile(originalPath,'utf8');
  const { evaluatePatternV2: actualEvaluator }=await import(
    pathToFileURL(originalPath).href);
  const directory=await mkdtemp(join(root,'.cep-mutants-'));
  const results=[];
  try {
    for(const mutation of mutants) {
      const fixture=cases[mutation.fixture];
      assert.ok(fixture,'mutation fixture missing');
      assert.equal(original.split(mutation.find).length-1,1,
        'compiled production mutation anchor must be unique: '+mutation.id);
      const code=original.replace(mutation.find,mutation.replace);
      assert.notEqual(code,original,'mutation must actually alter compiled evaluator');
      const clone=join(directory,mutation.id,'src');
      await cp(compiled,clone,{recursive:true,errorOnExist:true});
      const modifiedPath=join(clone,evaluatorFile);
      await writeFile(modifiedPath,code);
      // Dynamic import compiles the *actual altered production module*,
      // along with its copied relative dependencies.
      const { evaluatePatternV2: mutantEvaluator }=await import(
        pathToFileURL(modifiedPath).href);
      assert.equal(typeof mutantEvaluator,'function',
        'syntactically invalid mutants must not count as killed');
      const expected={...fixture.expected,
        matches:[...fixture.expected.matches].sort(),
        pending:[...fixture.expected.pending].sort()};
      let witnesses=0;
      const observed=[];
      for(let round=1;round<=16;round++) {
        const baseline=await runCase(actualEvaluator,fixture,round);
        assert.deepEqual(baseline,expected,
          mutation.id+'/baseline/seed='+round);
        const mutant=await runCase(mutantEvaluator,fixture,round);
        observed.push(mutant);
        if (JSON.stringify(mutant)!==JSON.stringify(expected)) witnesses++;
      }
      assert.equal(witnesses,16,
        'mutation survived finite oracle: '+mutation.id+
          ' ('+witnesses+'/16 killed)');
      results.push({
        mutation:mutation.id,fixture:mutation.fixture,
        sourcePatternSha256:hash(mutation.find),
        mutantCompiledSha256:hash(code),
        fixtureSha256:hash(JSON.stringify({
          definition:fixture.definition,events:fixture.events,
          now:fixture.now.toISOString(),
          allowedLatenessMs:fixture.allowedLatenessMs??0,
        })),
        evaluated:16,killed:witnesses,expected,
        sampleMutant:observed[0],
      });
    }
  } finally {
    await rm(directory,{recursive:true,force:true});
  }
  return {
    format:MUTATION_CORPUS_VERSION,seed,
    compiledEvaluatorSha256:hash(original),
    node:process.version,
    platform:process.platform,
    packageCommit:process.env.GITHUB_SHA??null,
    mutants:results,
    totalMutants:results.length,
    killedMutants:results.filter(row=>row.killed===row.evaluated).length,
  };
}
