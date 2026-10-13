import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { attestCompiledRuntime } from './compiled-runtime-attestation.mjs';
import os from 'node:os';
import {
  PatternAstV2DefinitionSchema,
  evaluatePatternV2,
} from '../../dist/src/intelligenceProtocol/index.js';

function event(ref, id, at, data = {}) {
  return {
    clauseId: ref,
    traceId: `conf-${id}`,
    sourceEventId: id,
    eventName: `${ref}.event`,
    occurredAt: at,
    provider: 'conformance',
    serverId: 'conformance',
    subscriptionArguments: {},
    data,
  };
}

function pattern(root, extra = {}) {
  return PatternAstV2DefinitionSchema.parse({
    version: '2',
    root,
    partitionBy: extra.partitionBy ?? [],
    selection: extra.selection ?? {
      overlap: 'allow',
      afterMatch: 'keepAll',
      maxMatchesPerEvent: 100,
    },
    execution: extra.execution ?? {
      maxCandidates: 2048,
      maxSemanticEvaluations: 8,
      maxBufferedEvents: 10000,
    },
  });
}

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function shuffle(values, random) {
  const output = [...values];
  for (let i = output.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [output[i], output[j]] = [output[j], output[i]];
  }
  return output;
}

const packageData = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
);
const fileContent = await readFile(new URL(import.meta.url));

// The complete executable tree is fingerprinted, and any symlinked
// module or directory makes attestation fail closed.
const compiledRuntime = await attestCompiledRuntime(fileURLToPath(
  new URL('../../dist/src/', import.meta.url),
));
// These are the actual compiled modules loaded by evaluatePatternV2().
// Hashing only this harness or the package version would allow a different
// evaluator to masquerade as the same conformance execution.
const evaluatedModules = await Promise.all([
  'dist/src/patternV2/evaluator.js',
  'dist/src/intelligenceProtocol/patternV2Schemas.js',
  'dist/src/semantic/conditionEngine.js',
].map(async modulePath => ({
  path: modulePath,
  sha256: createHash('sha256')
    .update(await readFile(new URL('../../' + modulePath, import.meta.url)))
    .digest('hex'),
})));
const sha256 = value => createHash('sha256')
  .update(typeof value === 'string' || Buffer.isBuffer(value)
    ? value : JSON.stringify(value))
  .digest('hex');
const buildSha256 = compiledRuntime.sha256;
const lockfileSha256 = sha256(
  await readFile(new URL('../../package-lock.json', import.meta.url)),
);

const checks = [];
async function check(name, fn) {
  const started = performance.now();
  // The case runner MUST provide replay evidence. Missing provenance is
  // a report failure, not a successful test with an empty attestation.
  const evidence = await fn();
  assert.ok(evidence && evidence.definition && Array.isArray(evidence.events),
    'CEP conformance check must supply source inputs and definition');
  assert.ok(evidence.outcomes &&
    Number.isSafeInteger(evidence.outcomes.complete) &&
    Number.isSafeInteger(evidence.outcomes.inconclusive) &&
    Number.isSafeInteger(evidence.runs) &&
    evidence.runs === evidence.outcomes.complete + evidence.outcomes.inconclusive,
    'CEP conformance outcome totals must account for all evaluations');
  checks.push({
    name,
    ok: true,
    durationMs: performance.now() - started,
    runs: evidence.runs,
    seedRange: evidence.seedRange ?? null,
    inputSha256: sha256({
      definition: evidence.definition,
      events: evidence.events,
      clocks: evidence.clocks ?? [],
    }),
    inputEventCount: evidence.events.length,
    budgets: evidence.definition.execution,
    outcomes: evidence.outcomes,
  });
}

await check('event-time order is delivery-order invariant for followedBy', async () => {
  const definition = pattern({
    kind: 'sequence',
    contiguity: 'followedBy',
    children: [
      { kind: 'event', ref: 'a' },
      { kind: 'event', ref: 'b' },
    ],
  });
  const source = [
    event('a', 'a1', '2026-09-30T10:00:00.000Z'),
    event('b', 'b1', '2026-09-30T10:01:00.000Z'),
    event('a', 'a2', '2026-09-30T10:02:00.000Z'),
    event('b', 'b2', '2026-09-30T10:03:00.000Z'),
  ];
  const expected = await evaluatePatternV2({ definition, events: source });
  const expectedIds = expected.matches.map((candidate) =>
    candidate.events.map((item) => item.sourceEventId).join(','));

  for (let seed = 1; seed <= 50; seed += 1) {
    const result = await evaluatePatternV2({
      definition,
      events: shuffle(source, seeded(seed)),
    });
    assert.equal(result.truncated, false, 'seed=' + seed);
    assert.deepEqual(
      result.matches.map((candidate) =>
        candidate.events.map((item) => item.sourceEventId).join(',')),
      expectedIds,
    );
  }
  assert.equal(expected.truncated, false);
  return {
    definition, events: source, seedRange: [1, 50], runs: 51,
    outcomes: { complete: 51, inconclusive: 0 },
  };
});

await check('candidate budget bounds combinations', async () => {
  const definition = pattern({
    kind: 'repeat',
    child: { kind: 'event', ref: 'x' },
    min: 3,
    max: 8,
    mode: 'greedy',
    contiguity: 'combinations',
  }, {
    execution: {
      maxCandidates: 64,
      maxSemanticEvaluations: 0,
      maxBufferedEvents: 1000,
    },
  });
  const events = Array.from({ length: 20 }, (_, i) =>
    event('x', `x-${i}`, new Date(Date.UTC(2026, 8, 30, 10, 0, i)).toISOString()));
  const result = await evaluatePatternV2({ definition, events });
  assert.equal(result.truncated, true);
  assert.ok(result.matches.length <= 64);
  return {
    definition, events, runs: 1,
    outcomes: { complete: 0, inconclusive: 1 },
  };
});

await check('negative pattern waits through allowed lateness', async () => {
  const definition = pattern({
    kind: 'notFollowedBy',
    id: 'quiet',
    child: { kind: 'event', ref: 'deploy' },
    forbidden: { kind: 'event', ref: 'error' },
    withinMs: 60_000,
  });
  const events = [
    event('deploy', 'deploy-1', '2026-09-30T10:00:00.000Z'),
  ];
  const pending = await evaluatePatternV2({
    definition,
    events,
    allowedLatenessMs: 30_000,
    now: new Date('2026-09-30T10:01:10.000Z'),
  });
  assert.equal(pending.matches.length, 0);
  assert.equal(pending.pending.length, 1);

  const forbidden = await evaluatePatternV2({
    definition,
    events: [
      ...events,
      event('error', 'error-1', '2026-09-30T10:00:30.000Z'),
    ],
    allowedLatenessMs: 30_000,
    now: new Date('2026-09-30T10:01:10.000Z'),
  });
  assert.equal(forbidden.matches.length, 0);
  assert.equal(forbidden.pending.length, 0);
  assert.equal(pending.truncated, false);
  assert.equal(forbidden.truncated, false);
  return {
    definition,
    events: [...events, event('error', 'error-1', '2026-09-30T10:00:30.000Z')],
    clocks: ['2026-09-30T10:01:10.000Z'],
    runs: 2,
    outcomes: { complete: 2, inconclusive: 0 },
  };
});

await check('semantic node is explicit and budgeted', async () => {
  let calls = 0;
  const evaluator = {
    async evaluate() {
      calls += 1;
      return {
        evaluator: 'conformance/fake',
        probability: 0.95,
        matched: true,
        rejected: false,
        uncertain: false,
        metadata: {},
      };
    },
  };
  const definition = pattern({
    kind: 'semantic',
    id: 'same-problem',
    refs: ['issue', 'mail'],
    instruction: 'Same underlying problem?',
    input: ['issue.title', 'mail.subject'],
    matchThreshold: 0.8,
    rejectThreshold: 0.2,
    uncertain: 'escalate',
    execution: {
      cache: true,
      timeoutMs: 1000,
      onUnavailable: 'error',
    },
    child: {
      kind: 'allOf',
      children: [
        { kind: 'event', ref: 'issue' },
        { kind: 'event', ref: 'mail' },
      ],
    },
  }, {
    execution: {
      maxCandidates: 128,
      maxSemanticEvaluations: 1,
      maxBufferedEvents: 1000,
    },
  });
  const result = await evaluatePatternV2({
    definition,
    evaluator,
    events: [
      event('issue', 'issue-1', '2026-09-30T10:00:00.000Z', {
        title: 'Payment failed',
      }),
      event('mail', 'mail-1', '2026-09-30T10:01:00.000Z', {
        subject: 'Payment failed again',
      }),
    ],
  });
  assert.equal(result.matches.length, 1);
  assert.equal(calls, 1);
  assert.equal(result.semanticEvaluations, 1);
  assert.equal(result.truncated, false);
  return {
    definition,
    events: [
      event('issue', 'issue-1', '2026-09-30T10:00:00.000Z', {
        title: 'Payment failed',
      }),
      event('mail', 'mail-1', '2026-09-30T10:01:00.000Z', {
        subject: 'Payment failed again',
      }),
    ],
    runs: 1,
    outcomes: { complete: 1, inconclusive: 0 },
  };
});


const summary = checks.reduce((totals, entry) => ({
  complete: totals.complete + entry.outcomes.complete,
  inconclusive: totals.inconclusive + entry.outcomes.inconclusive,
}), { complete: 0, inconclusive: 0 });

console.log(JSON.stringify({
  schema: 'event-intelligence.pattern-conformance.v3',
  generatedAt: new Date().toISOString(),
  package: { name: packageData.name, version: packageData.version },
  patternAstVersion: '2',
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    commit: /^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? '')
      ? process.env.GITHUB_SHA : null,
  },
  reproducibility: {
    replay: 'npm run conformance:pattern-v2',
    source: 'scripts/evidence/pattern-v2-conformance.mjs',
    sourceSha256: sha256(fileContent),
    evaluatedModules,
    completeRuntimeBuild: {
      root: 'dist/src',
      sha256: buildSha256,
      fileCount: compiledRuntime.fileCount,
      fileEncoding: 'SHA-256(JSON.stringify(sorted [{path,sha256}]))',
    },
    dependencyLockSha256: lockfileSha256,
    inputEncoding: 'SHA-256(JSON.stringify({definition,events,clocks}))',
    seedAlgorithm: 'LCG(1664525,1013904223); Fisher-Yates shuffle',
    note: 'Synthetic, bounded fixtures only; hashed input commitments, not raw event data.',
  },
  checks,
  passed: checks.length,
  failed: 0,
  evaluations: summary,
}, null, 2));
