import { performance } from 'node:perf_hooks';
import {
  PatternAstV2DefinitionSchema,
  evaluatePatternV2,
} from '../../dist/src/intelligenceProtocol/index.js';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function intArg(name, fallback) {
  const value = Number(arg(name, fallback));
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`--${name} must be a positive number`);
  }
  return Math.floor(value);
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(q * sorted.length) - 1),
  );
  return sorted[index];
}

function event(ref, id, ms, data = {}) {
  return {
    clauseId: ref,
    traceId: `bench-${id}`,
    sourceEventId: id,
    eventName: `${ref}.event`,
    occurredAt: new Date(ms).toISOString(),
    provider: 'evidence-harness',
    serverId: 'bench',
    subscriptionArguments: {},
    data,
  };
}

function pattern(root, execution = {}) {
  return PatternAstV2DefinitionSchema.parse({
    version: '2',
    root,
    partitionBy: [],
    selection: {
      overlap: 'allow',
      afterMatch: 'keepAll',
      maxMatchesPerEvent: 100,
    },
    execution: {
      maxCandidates: execution.maxCandidates ?? 2048,
      maxSemanticEvaluations: execution.maxSemanticEvaluations ?? 0,
      maxBufferedEvents: execution.maxBufferedEvents ?? 100000,
    },
  });
}

function scenarios(eventCount) {
  const base = Date.UTC(2026, 8, 30, 12, 0, 0);
  const sequenceEvents = [];
  for (let i = 0; i < eventCount; i += 1) {
    sequenceEvents.push(
      event(i % 2 === 0 ? 'a' : 'b', `seq-${i}`, base + i, {
        value: i,
      }),
    );
  }

  const aggregateEvents = Array.from({ length: eventCount }, (_, i) =>
    event('order', `order-${i}`, base + i, {
      total: (i % 100) + 1,
    }));

  const combinationEvents = Array.from(
    { length: Math.min(eventCount, 24) },
    (_, i) => event('failure', `failure-${i}`, base + i),
  );

  return [
    {
      name: 'sequence-followedBy',
      events: sequenceEvents,
      definition: pattern({
        kind: 'sequence',
        contiguity: 'followedBy',
        children: [
          { kind: 'event', ref: 'a' },
          { kind: 'event', ref: 'b' },
        ],
      }),
    },
    {
      name: 'aggregate-window',
      events: aggregateEvents,
      definition: pattern({
        kind: 'aggregate',
        function: 'sum',
        ref: 'order',
        path: 'total',
        op: 'gte',
        value: Math.max(1, Math.floor(eventCount / 2)),
        child: {
          kind: 'window',
          window: {
            type: 'count',
            size: Math.min(eventCount, 128),
          },
          child: {
            kind: 'repeat',
            child: { kind: 'event', ref: 'order' },
            min: Math.min(eventCount, 8),
            max: Math.min(eventCount, 8),
            mode: 'greedy',
            contiguity: 'relaxed',
          },
        },
      }),
    },
    {
      name: 'candidate-explosion-bounded',
      events: combinationEvents,
      definition: pattern(
        {
          kind: 'repeat',
          child: { kind: 'event', ref: 'failure' },
          min: 3,
          max: 5,
          mode: 'greedy',
          contiguity: 'combinations',
        },
        { maxCandidates: 512 },
      ),
    },
  ];
}

async function runScenario(scenario, iterations) {
  const latencies = [];
  let matches = 0;
  let truncated = 0;
  const before = process.memoryUsage();

  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    const result = await evaluatePatternV2({
      definition: scenario.definition,
      events: scenario.events,
      now: new Date('2026-10-01T00:00:00.000Z'),
    });
    latencies.push(performance.now() - started);
    matches += result.matches.length;
    truncated += result.truncated ? 1 : 0;
  }

  const after = process.memoryUsage();
  const sorted = [...latencies].sort((a, b) => a - b);
  const totalMs = latencies.reduce((sum, value) => sum + value, 0);
  const evaluatedEvents = scenario.events.length * iterations;

  return {
    name: scenario.name,
    eventsPerEvaluation: scenario.events.length,
    iterations,
    evaluatedEvents,
    matches,
    truncatedEvaluations: truncated,
    latencyMs: {
      p50: quantile(sorted, 0.50),
      p95: quantile(sorted, 0.95),
      p99: quantile(sorted, 0.99),
      max: sorted.at(-1) ?? 0,
      mean: totalMs / iterations,
    },
    throughputEventsPerSecond:
      totalMs > 0 ? evaluatedEvents / (totalMs / 1000) : 0,
    memoryBytes: {
      heapUsedDelta: after.heapUsed - before.heapUsed,
      rssDelta: after.rss - before.rss,
    },
  };
}

const profile = String(arg('profile', 'quick')).toLowerCase();
if (!['quick', 'full'].includes(profile)) {
  throw new Error('--profile must be quick or full');
}

const defaults = profile === 'full'
  ? { events: 10000, iterations: 25 }
  : { events: 250, iterations: 5 };
const eventCount = intArg('events', defaults.events);
const iterations = intArg('iterations', defaults.iterations);

const results = [];
for (const scenario of scenarios(eventCount)) {
  results.push(await runScenario(scenario, iterations));
}

console.log(JSON.stringify({
  schema: 'event-intelligence.pattern-v2-benchmark.v1',
  generatedAt: new Date().toISOString(),
  node: process.version,
  profile,
  eventCount,
  iterations,
  results,
}, null, 2));
