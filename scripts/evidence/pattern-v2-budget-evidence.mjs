import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PatternAstV2DefinitionSchema,
  evaluatePatternV2,
} from '../../dist/src/intelligenceProtocol/index.js';

const ROOT = new URL('../../', import.meta.url);
const SEED = 20261014;
const FIXED_NOW = '2026-10-14T10:01:10.000Z';
const TIME_ORIGIN = Date.UTC(2026, 9, 14, 10, 0, 0);

function digest(value) {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

function occurrence(ref, index) {
  return {
    clauseId: ref,
    traceId: 'cep-budget-20261014:trace:' + index,
    sourceEventId: 'cep-budget-20261014:' + ref + ':' + index,
    eventName: ref + '.event',
    occurredAt: new Date(TIME_ORIGIN + index * 1000).toISOString(),
    provider: 'synthetic',
    serverId: 'budget-conformance',
    subscriptionArguments: {},
    data: {},
  };
}

function definition(root, maxCandidates, maxSemanticEvaluations = 0) {
  return PatternAstV2DefinitionSchema.parse({
    version: '2',
    root,
    partitionBy: [],
    selection: {
      overlap: 'allow', afterMatch: 'keepAll', maxMatchesPerEvent: 100,
    },
    execution: {
      maxCandidates, maxSemanticEvaluations, maxBufferedEvents: 100,
    },
  });
}

const nextAfterChoice = {
  kind: 'sequence',
  contiguity: 'next',
  children: [
    {
      kind: 'anyOf',
      children: [
        { kind: 'event', ref: 'a' },
        { kind: 'event', ref: 'b' },
      ],
    },
    { kind: 'event', ref: 'c' },
  ],
};

const negative = {
  kind: 'notFollowedBy',
  id: 'no-error-after-deploy',
  child: { kind: 'event', ref: 'deploy' },
  forbidden: { kind: 'event', ref: 'error' },
  withinMs: 60000,
};

const semantic = {
  kind: 'semantic',
  id: 'budgeted-triage',
  refs: ['issue'],
  instruction: 'Is this event important?',
  input: ['issue.title'],
  matchThreshold: 0.8,
  rejectThreshold: 0.2,
  uncertain: 'reject',
  execution: {
    cache: false,
    timeoutMs: 1000,
    onUnavailable: 'error',
  },
  child: { kind: 'event', ref: 'issue' },
};

/**
 * Diagnostic interpretation of evaluator output, NOT a second evaluator or
 * public EI API. Truncation wins over matches and over absence of matches.
 */
export function interpretEvaluation(result) {
  if (result.truncated) return 'incomplete_budget';
  if (result.pending.length) return 'awaiting_temporal_finality';
  if (result.matches.length) return 'matched';
  return 'complete_no_match';
}

function summarizeResult(result) {
  return {
    interpretation: interpretEvaluation(result),
    truncated: result.truncated,
    matches: result.matches.map(match =>
      match.events.map(event => event.sourceEventId)),
    pending: result.pending.map(match =>
      match.events.map(event => event.sourceEventId)),
    semanticEvaluations: result.semanticEvaluations,
  };
}

/** Generates a finite, reproducible diagnostic evidence report. */
export async function runBudgetEvidence() {
  const input = [
    occurrence('a', 0),
    occurrence('noise', 1),
    occurrence('b', 2),
    occurrence('c', 3),
  ];
  const cases = [
    {
      name: 'candidate-budget-zero-match-is-inconclusive',
      config: definition(nextAfterChoice, 1),
      source: input,
      expected: 'incomplete_budget',
    },
    {
      name: 'candidate-budget-sufficient-returns-real-match',
      config: definition(nextAfterChoice, 32),
      source: input,
      expected: 'matched',
    },
    {
      name: 'complete-negative-without-required-c-is-no-match',
      config: definition(nextAfterChoice, 32),
      source: input.slice(0, 3),
      expected: 'complete_no_match',
    },
    {
      name: 'temporal-negative-has-pending-window',
      config: definition(negative, 32),
      source: [occurrence('deploy', 0)],
      expected: 'awaiting_temporal_finality',
    },
    {
      name: 'semantic-budget-reports-incomplete-results',
      config: definition(semantic, 32, 1),
      source: [
        occurrence('issue', 0),
        occurrence('issue', 1),
        occurrence('issue', 2),
      ],
      expected: 'incomplete_budget',
    },
  ];
  const records = [];
  let semanticCalls = 0;
  for (const entry of cases) {
    const evaluator = entry.name.startsWith('semantic-') ? {
      cacheIdentity: 'conformance/no-network:v1',
      async evaluate() {
        semanticCalls++;
        return {
          evaluator: 'conformance/no-network:v1',
          probability: 0.95,
          matched: true,
          rejected: false,
          uncertain: false,
          metadata: {},
        };
      },
    } : null;

    const result = await evaluatePatternV2({
      definition: entry.config,
      events: entry.source,
      evaluator,
      now: new Date(FIXED_NOW),
      allowedLatenessMs: entry.name.startsWith('temporal-') ? 30000 : 0,
    });
    const outcome = summarizeResult(result);
    assert.equal(outcome.interpretation, entry.expected, entry.name);
    records.push({
      name: entry.name,
      seed: SEED,
      definitionHash: digest(entry.config),
      definition: entry.config,
      sourceHash: digest(entry.source),
      sources: entry.source,
      fixedNow: FIXED_NOW,
      allowedLatenessMs: entry.name.startsWith('temporal-') ? 30000 : 0,
      output: outcome,
    });
  }
  assert.equal(semanticCalls, 1,
    'semantic evaluator must never exceed configured call budget');
  const pkg = JSON.parse(
    await readFile(new URL('package.json', ROOT), 'utf8'),
  );
  return {
    schema: 'event-intelligence.cep-budget-evidence.v1',
    environment: {
      packageVersion: pkg.version,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      commit: process.env.GITHUB_SHA ?? null,
    },
    seed: SEED,
    cases: records,
    caveat: 'Finite synthetic diagnostic evidence; incomplete_budget is not no-match or authorization to perform an external action. No multi-worker/restart/partition guarantee.',
  };
}

if (process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 2 || (args.length && (args[0] !== '--out' || !args[1]))) {
    console.error('Usage: node scripts/evidence/pattern-v2-budget-evidence.mjs [--out path]');
    process.exitCode = 2;
  } else {
    const report = await runBudgetEvidence();
    const json = JSON.stringify(report, null, 2) + '\n';
    if (args.length === 2) {
      await writeFile(args[1], json, { flag: 'w' });
    } else {
      process.stdout.write(json);
    }
  }
}
