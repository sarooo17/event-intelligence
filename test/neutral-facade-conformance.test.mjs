import assert from 'node:assert/strict';
import test from 'node:test';
import { runHostConformance } from '../scripts/host-conformance.mjs';
import { referenceHostAdapter } from '../conformance/reference-host.mjs';

test('neutral embedded facade passes full management conformance with real EI store and engine', async () => {
  const adapter = {
    name: 'neutral-facade-reference-host',
    createHarness(options) {
      return referenceHostAdapter.createHarness({
        ...options,
        useNeutralFacade: true,
      });
    },
  };
  const report = await runHostConformance(adapter, {
    profile: 'management',
    throwOnFailure: true,
  });
  assert.equal(report.schema, 'event-intelligence.host-conformance.v2');
  assert.equal(report.passed, true);
  assert.deepEqual(report.summary, {
    total: 6,
    passed: 6,
    failed: 0,
  });
  assert.ok(report.observability.eventNames.includes('ei.wake.delivered'));
});
