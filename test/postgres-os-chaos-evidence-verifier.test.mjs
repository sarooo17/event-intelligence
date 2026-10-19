import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyOsChaosEvidence } from '../scripts/evidence/verify-postgres-os-chaos.mjs';

const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const log = [
  'TAP version 13',
  '# Subtest: real SIGKILL PostgreSQL worker takeovers fence generations and keep distinct durable receipts',
  'ok 1 - real SIGKILL PostgreSQL worker takeovers fence generations and keep distinct durable receipts',
  '  ---',
  '  duration_ms: 1200',
  '  ...',
  '1..1',
  '# tests 1',
  '# pass 1',
  '# fail 0',
].join('\n');
const host = [
  'source-head-sha=' + SHA,
  'run-id=39299999999',
  'run-attempt=1',
  'rounds=3',
  'pg-driver=8.16.3',
  'v22.16.0',
  'Linux fixture',
].join('\n');

function fixture() {
  const evidence = [0, 1, 2].map(round => ({
    round,
    victimPid: 100 + round * 2,
    successorPid: 101 + round * 2,
    workerId: round % 2 === 0 ? 'logical-worker-a' : 'logical-worker-b',
    generation: 2,
    receiptId: 'fixture-receipt-os-kill-wake-' + round,
    killedSignal: 'SIGKILL',
    handoverMs: [100, 200, 300][round],
  }));
  return {
    report: {
      schema: 'ei-postgres-os-chaos-v1',
      kind: 'bounded-process-kill-and-reclaim',
      node: 'v22.16.0', postgresVersion: '16.8',
      pgDriverVersion: '8.16.3', platform: 'linux', arch: 'x64',
      rounds: 3, killsConfirmed: 3, recoveredReceipts: 3,
      totalDurationMs: 1200,
      handoverMs: { p50: 200, p95: 300, p99: 300 },
      evidence,
      limits: 'single PG16 instance, synthetic claims only; no provider/match/wake end-to-end or network partition',
    },
    host, log, rounds: 3, commit: SHA,
  };
}
function shouldReject(patch, description) {
  const state = fixture();
  patch(state);
  assert.throws(() => verifyOsChaosEvidence(state),
    error => error?.code === 'EI_OS_CHAOS_EVIDENCE_INVALID',
    description);
}

test('accept one internally consistent, exact-commit, durable 3-round fixture report', () => {
  const result = verifyOsChaosEvidence(fixture());
  assert.equal(result.ok, true);
  assert.equal(result.rounds, 3);
  assert.equal(result.killsConfirmed, 3);
  assert.equal(result.recoveredReceipts, 3);
  assert.equal(result.sourceCommit, SHA);
  assert.equal(result.actionsRunId, '39299999999');
});

test('reject incomplete marker, missing success/test report, wrong source SHA', () => {
  shouldReject(x => { x.report = { schema: 'ei-postgres-os-chaos-v1', status: 'incomplete' }; },
    'explicit failure marker must never certify 60 rounds');
  shouldReject(x => { x.report.schema = 'other'; }, 'wrong schema');
  shouldReject(x => { x.report.kind = 'unknown'; }, 'wrong kind');
  shouldReject(x => { x.commit = '0'.repeat(40); }, 'commit mismatch');
  shouldReject(x => { x.commit = 'short'; }, 'invalid commit argument');
  shouldReject(x => { x.host = x.host.replace('rounds=3', 'rounds=60'); }, 'wrong request');
  shouldReject(x => { x.log = x.log.replace('# fail 0', '# fail 1'); }, 'failed test');
  shouldReject(x => { x.log += '\nnot ok 2 - another worker'; }, 'mixed passes/failures');
  shouldReject(x => { x.log = ''; }, 'missing raw test log');
});

test('reject missing, invented or duplicated kill/reclaim evidence', () => {
  shouldReject(x => { x.report.rounds = 2; }, 'rounds mismatch');
  shouldReject(x => { x.report.killsConfirmed = 2; }, 'kill count mismatch');
  shouldReject(x => { x.report.recoveredReceipts = 2; }, 'receipt count mismatch');
  shouldReject(x => { x.report.evidence.pop(); }, 'missing round details');
  shouldReject(x => { x.report.evidence[1].round = 0; }, 'duplicated round index');
  shouldReject(x => { x.report.evidence[0].killedSignal = 'SIGTERM'; }, 'SIGKILL required');
  shouldReject(x => { x.report.evidence[1].generation = 1; }, 'ABA fencing');
  shouldReject(x => { x.report.evidence[1].workerId = 'logical-worker-a'; }, 'worker alternation');
  shouldReject(x => { x.report.evidence[1].successorPid = x.report.evidence[1].victimPid; },
    'distinct OS PIDs required');
  shouldReject(x => { x.report.evidence[1].receiptId = x.report.evidence[0].receiptId; },
    'must reject reused receipt');
  shouldReject(x => { x.report.evidence[0].handoverMs = 0; }, 'zero timing');
  shouldReject(x => { x.report.evidence[0].handoverMs = Number.POSITIVE_INFINITY; },
    'nonfinite timing');
  shouldReject(x => { x.report.evidence[1].handoverMs = 2000; },
    'handovers cannot exceed the full run duration');
});

test('recalculate p50/p95/p99 and require complete environment provenance', () => {
  shouldReject(x => { x.report.handoverMs.p95 = 250; }, 'tampered p95');
  shouldReject(x => { x.report.handoverMs.p50 = 300; }, 'tampered p50');
  shouldReject(x => { x.report.handoverMs.p99 = 0; }, 'tampered p99');
  shouldReject(x => { x.report.totalDurationMs = -1; }, 'negative run wall time');
  shouldReject(x => { x.report.postgresVersion = ''; }, 'PG version required');
  shouldReject(x => { x.report.pgDriverVersion = '8.15.0'; }, 'driver pin mismatch');
  shouldReject(x => { x.report.node = 'v21.0.0'; }, 'node mismatch');
  shouldReject(x => { x.host = x.host.replace('run-id=39299999999', 'run-id=bad'); }, 'actions provenance');
  shouldReject(x => { x.report.limits = ''; }, 'limits always stated');
});
