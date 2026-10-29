import assert from 'node:assert/strict';
import test from 'node:test';
import { TriggerInspector } from '../scripts/lib/trigger-inspector.mjs';

const at = '2026-10-29T12:00:00.000Z';
const secret = 'PRIVATE_PROVIDER_PAYLOAD_NOT_FOR_EXPLAIN';

function fixture(n = 1200, derivedCount = 1100) {
  const sourceEvents = Array.from({ length: n }, (_, i) => ({
    clauseId: i === n - 1 ? 'late' : 'early',
    traceId: 'trace-' + i, serverId: 'provider',
    eventName: i === n - 1 ? 'job.finished' : 'job.started',
    sourceEventId: 'source-' + i, occurredAt: at,
    data: { secret, evidence: { nested: secret } },
  }));
  const match = {
    matchId: 'partial-large', triggerId: 't', triggerVersion: '1',
    status: 'partial', sourceEvents, partitionKey: null,
    openedAt: at, updatedAt: at, expiresAt: null,
    patternState: null, firedWakeId: null, derivedEventIds: [],
  };
  return {
    listTriggers: () => [{
      triggerId: 't', version: '1', clauses: [
        { id: 'early', event: 'job.started' },
        { id: 'late', event: 'job.finished' },
        { id: 'missing', event: 'deployment.ready' },
      ],
      pattern: { root: { kind: 'allOf', children: [
        { kind: 'event', ref: 'early' },
        { kind: 'event', ref: 'late' },
        { kind: 'event', ref: 'missing' },
      ] } },
    }],
    getTriggerState: () => ({ status: 'active', fireCount: 0 }),
    listTriggerMatches: () => [match],
    listTriggerMatchHistory: () => [match],
    listTemporalDeadlines: () => [],
    listDerivedEvents: () => Array.from({ length: derivedCount }, (_, i) => ({
      event: {
        sourceEventId: 'derived-' + i, name: 'derived.job',
        occurredAt: at, data: { secret },
      },
      directParents: [], rootEvidence: [],
    })),
  };
}

test('opt-in reference cap bounds source and derived output without inventing missing clauses', async () => {
  const inspected = await new TriggerInspector({
    store: fixture(), evidenceRefLimit: 7, matchHistoryLimit: 1,
  }).inspect({ triggerId: 't' });
  assert.equal(inspected.lineage.evidence.length, 7);
  assert.equal(inspected.lineage.derivedOutputs.length, 7);
  assert.equal(inspected.evidenceSummary.evidenceRefLimit, 7);
  assert.equal(inspected.evidenceSummary.sourceRefCount, 1200);
  assert.equal(inspected.evidenceSummary.derivedRefCount, 1100);
  assert.equal(inspected.evidenceSummary.sourceRefsTruncated, true);
  assert.equal(inspected.evidenceSummary.derivedRefsTruncated, true);

  const early = inspected.clauses.find(x => x.clauseId === 'early');
  const late = inspected.clauses.find(x => x.clauseId === 'late');
  const missing = inspected.clauses.find(x => x.clauseId === 'missing');
  assert.equal(early.observedCount, 1199);
  assert.equal(early.evidence.length, 7);
  assert.equal(late.status, 'observed', 'later evidence is still counted');
  assert.equal(late.observedCount, 1);
  assert.equal(late.evidence.length, 0, 'ref-only projection cap is global');
  assert.equal(missing.status, 'waiting');
  assert.deepEqual(inspected.evidenceSummary.observedClauseIds, ['early', 'late']);
  assert.deepEqual(inspected.evidenceSummary.unobservedClauseIds, ['missing']);
  assert.deepEqual(inspected.diagnosis.missingClauseIds, ['missing']);
  assert.equal(inspected.diagnosis.sourceCertainty, 'unverified');
  assert.equal(JSON.stringify(inspected).includes(secret), false);
  assert.equal(JSON.stringify(inspected).includes('derived-10'), false);
});

test('default inspection preserves original full evidence projection', async () => {
  const view = await new TriggerInspector({store: fixture(8, 9)})
    .inspect({triggerId: 't'});
  assert.equal(view.lineage.evidence.length, 8);
  assert.equal(view.lineage.derivedOutputs.length, 9);
  assert.equal(view.evidenceSummary.evidenceRefLimit, null);
  assert.equal(view.evidenceSummary.sourceRefsTruncated, false);
  assert.equal(view.evidenceSummary.derivedRefsTruncated, false);
  assert.equal(view.clauses.find(x => x.clauseId === 'late').evidence.length, 1);
});

test('evidence bounds have fail-closed configuration and restart-identical output', async () => {
  for (const invalid of [0, -1, 1.1, 501, NaN, Infinity, '10', false]) {
    assert.throws(
      () => new TriggerInspector({ store: fixture(2, 1), evidenceRefLimit: invalid }),
      /evidenceRefLimit/,
    );
  }
  const first = await new TriggerInspector({store: fixture(120, 72), evidenceRefLimit: 5})
    .inspect({triggerId: 't'});
  const restarted = await new TriggerInspector({store: fixture(120, 72), evidenceRefLimit: 5})
    .inspect({triggerId: 't'});
  assert.deepEqual(first, restarted);
  assert.equal(first.evidenceSummary.sourceRefsTruncated, true);
  assert.equal(first.causalTimeline.sourceLimit, 32);
  assert.equal(first.causalTimeline.upstreamCompleteness, 'unknown');
});

test('zero references does not claim nonexistent upstream events', async () => {
  const view = await new TriggerInspector({
    store: fixture(0, 0), evidenceRefLimit: 2,
  }).inspect({ triggerId: 't' });
  assert.equal(view.evidenceSummary.sourceRefCount, 0);
  assert.equal(view.evidenceSummary.sourceRefsTruncated, false);
  assert.deepEqual(view.diagnosis.missingClauseIds, ['early', 'late', 'missing']);
  assert.equal(view.diagnosis.sourceCertainty, 'unverified');
});
