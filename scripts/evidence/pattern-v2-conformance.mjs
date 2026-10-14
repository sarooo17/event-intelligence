import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import os from 'node:os';

let PatternAstV2DefinitionSchema;
let evaluatePatternV2;

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
// Every executed attestation must use the exact helper bytes fingerprinted
// in the report. A static import could load old code before a concurrent
// checkout update, then hash different bytes from the changed source file.
const trustedRepoRoot = fileURLToPath(new URL('../../', import.meta.url));
const buildRoot = fileURLToPath(new URL('../../dist/src/', import.meta.url));
const snapshotWorkspace = await mkdtemp(join(trustedRepoRoot, '.cep-conformance-snapshot-'));
try {
  const snapshotHelper = join(snapshotWorkspace, 'compiled-runtime-attestation.mjs');
  await writeFile(snapshotHelper,
    await readFile(new URL('./compiled-runtime-attestation.mjs', import.meta.url)),
    { flag: 'wx' });
  const attestationHelperContent = await readFile(snapshotHelper);
  const helperSha256 = createHash('sha256')
    .update(attestationHelperContent).digest('hex');
  // Dynamic import from the same isolated, fingerprinted file instead of the
  // mutable working tree. Verify the snapshot has not changed after execution.
  const { attestCompiledRuntime } = await import(pathToFileURL(snapshotHelper).href);
  const originalBuild = await attestCompiledRuntime(buildRoot, trustedRepoRoot);
  const snapshotRoot = join(snapshotWorkspace, 'dist', 'src');
  await cp(buildRoot, snapshotRoot, { recursive: true, errorOnExist: true });
  const compiledRuntime = await attestCompiledRuntime(snapshotRoot, snapshotWorkspace);
  assert.deepEqual(compiledRuntime, originalBuild,
    'compiled runtime changed during snapshot creation');
  ({ PatternAstV2DefinitionSchema, evaluatePatternV2 } = await import(
    pathToFileURL(join(snapshotRoot, 'intelligenceProtocol', 'index.js')).href
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
    .update(await readFile(join(snapshotRoot, modulePath.replace('dist/src/', ''))))
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
const fixedEvaluationNow = new Date('2026-10-14T12:00:00.000Z');
let observedRunInputs = [];
async function runEvaluation(options) {
  const { evaluatorFixture = null, ...evaluatorOptions } = options;
  if (evaluatorOptions.evaluator && !evaluatorFixture) {
    throw new Error('Semantic conformance requires a replayable synthetic evaluator fixture');
  }
  const args = {
    now: fixedEvaluationNow,
    allowedLatenessMs: 0,
    ...evaluatorOptions,
  };
  observedRunInputs.push({
    definition: args.definition,
    events: args.events,
    now: args.now.toISOString(),
    allowedLatenessMs: args.allowedLatenessMs,
    evaluatorFixture,
  });
  return evaluatePatternV2(args);
}
async function check(name, fn) {
  observedRunInputs = [];
  const started = performance.now();
  // The case runner MUST provide replay evidence. Missing provenance is
  // a report failure, not a successful test with an empty attestation.
  const evidence = await fn();
  assert.ok(evidence && evidence.definition && Array.isArray(evidence.events),
    'CEP conformance check must supply source inputs and definition');
  assert.ok(evidence.outcomes &&
    Number.isSafeInteger(evidence.outcomes.complete) &&
    Number.isSafeInteger(evidence.outcomes.inconclusive) &&
    Number.isSafeInteger(evidence.outcomes.pending) &&
    evidence.outcomes.complete >= 0 && evidence.outcomes.inconclusive >= 0 &&
    evidence.outcomes.pending >= 0 &&
    Number.isSafeInteger(evidence.runs) &&
    evidence.runs === evidence.outcomes.complete + evidence.outcomes.inconclusive +
      evidence.outcomes.pending,
    'CEP conformance outcome totals must account for all evaluations');
  assert.equal(observedRunInputs.length, evidence.runs,
    'every counted evaluation must have a canonical captured input');
  const perRunDigests = observedRunInputs.map(sha256);
  checks.push({
    name,
    ok: true,
    durationMs: performance.now() - started,
    runs: evidence.runs,
    seedRange: evidence.seedRange ?? null,
    inputSha256: sha256(perRunDigests),
    runInputSha256: perRunDigests,
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
  const expected = await runEvaluation({ definition, events: source });
  const expectedIds = expected.matches.map((candidate) =>
    candidate.events.map((item) => item.sourceEventId).join(','));

  for (let seed = 1; seed <= 50; seed += 1) {
    const result = await runEvaluation({
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
    outcomes: { complete: 51, inconclusive: 0, pending: 0 },
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
  const result = await runEvaluation({ definition, events });
  assert.equal(result.truncated, true);
  assert.ok(result.matches.length <= 64);
  return {
    definition, events, runs: 1,
    outcomes: { complete: 0, inconclusive: 1, pending: 0 },
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
  const pending = await runEvaluation({
    definition,
    events,
    allowedLatenessMs: 30_000,
    now: new Date('2026-09-30T10:01:10.000Z'),
  });
  assert.equal(pending.matches.length, 0);
  assert.equal(pending.pending.length, 1);

  const forbidden = await runEvaluation({
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
    outcomes: { complete: 1, inconclusive: 0, pending: 1 },
  };
});

await check('semantic node is explicit and budgeted', async () => {
  let calls = 0;
  const response = {
    evaluator: 'conformance/fake',
    probability: 0.95,
    matched: true,
    rejected: false,
    uncertain: false,
    metadata: {},
  };
  const evaluator = {
    async evaluate() {
      calls += 1;
      return { ...response, metadata: { ...response.metadata } };
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
  const result = await runEvaluation({
    definition,
    evaluator,
    evaluatorFixture: { identity: 'conformance/fake', response },
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
    outcomes: { complete: 1, inconclusive: 0, pending: 0 },
  };
});


const verifiedSnapshot = await attestCompiledRuntime(snapshotRoot, snapshotWorkspace);
assert.deepEqual(verifiedSnapshot, compiledRuntime,
  'compiled evaluator bytes changed after import/evaluation; aborting evidence report');
const verifiedHelperSha256 = createHash('sha256')
  .update(await readFile(snapshotHelper)).digest('hex');
assert.equal(verifiedHelperSha256, helperSha256,
  'loaded attestation helper bytes changed after import; aborting evidence report');

// Detect the working harness changing after the initial source fingerprint
// and before report emission (e.g. a concurrent checkout update).
assert.equal(sha256(await readFile(new URL(import.meta.url))),
  sha256(fileContent),
  'conformance harness changed during execution; aborting evidence report');

const summary = checks.reduce((totals, entry) => ({
  complete: totals.complete + entry.outcomes.complete,
  inconclusive: totals.inconclusive + entry.outcomes.inconclusive,
  pending: totals.pending + entry.outcomes.pending,
}), { complete: 0, inconclusive: 0, pending: 0 });

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
    attestationHelper: {
      path: 'scripts/evidence/compiled-runtime-attestation.mjs',
      sha256: helperSha256,
    },
    evaluatedModules,
    completeRuntimeBuild: {
      root: 'dist/src',
      sha256: buildSha256,
      fileCount: compiledRuntime.fileCount,
      fileEncoding: 'SHA-256(JSON.stringify(sorted [{path,sha256}]))',
    },
    dependencyLockSha256: lockfileSha256,
    inputEncoding: 'SHA-256(JSON.stringify(ordered per-run SHA-256 of {definition,events,now,allowedLatenessMs,evaluatorFixture}))',
    seedAlgorithm: 'LCG(1664525,1013904223); Fisher-Yates shuffle',
    note: 'Synthetic, bounded fixtures only; hashed input commitments, not raw event data.',
  },
  checks,
  passed: checks.length,
  failed: 0,
  evaluations: summary,
}, null, 2));
} finally {
  await rm(snapshotWorkspace, { recursive: true, force: true });
}
