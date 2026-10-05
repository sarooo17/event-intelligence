import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runHostConformance,
} from '../scripts/host-conformance.mjs';
import {
  referenceHostAdapter,
} from '../conformance/reference-host.mjs';

test('reference embedded host passes EI host conformance', async () => {
  const report = await runHostConformance(referenceHostAdapter);
  assert.equal(report.schema, 'event-intelligence.host-conformance.v1');
  assert.equal(report.passed, true, JSON.stringify(report, null, 2));
  assert.deepEqual(report.summary, {
    total: 5,
    passed: 5,
    failed: 0,
  });
  assert.ok(report.observability.eventNames.includes('ei.trigger.created'));
  assert.ok(report.observability.eventNames.includes('ei.match.matched'));
  assert.ok(report.observability.eventNames.includes('ei.wake.delivered'));
});
