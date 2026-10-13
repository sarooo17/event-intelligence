import assert from 'node:assert/strict';
import test from 'node:test';
import { runHostConformance } from '../scripts/host-conformance.mjs';
import { createProcessHostAdapter } from '../conformance/process-host-adapter.mjs';

test('v3 management conformance survives actual OS process termination and durable reopen', {
  timeout: 60000,
}, async () => {
  const processIds = [];
  const adapter = createProcessHostAdapter({
    onSpawn: pid => processIds.push(pid),
  });
  const report = await runHostConformance(adapter, {
    profile: 'management',
    throwOnFailure: true,
  });
  assert.equal(report.schema, 'event-intelligence.host-conformance.v3');
  assert.equal(report.passed, true, JSON.stringify(report, null, 2));
  assert.deepEqual(report.summary, { total: 7, passed: 7, failed: 0 });
  assert.ok(processIds.length >= 3, 'test must cross two process restarts');
  assert.equal(new Set(processIds).size, processIds.length,
    'every restart must spawn a different operating system process');
  assert.ok(report.observability.eventNames.includes('ei.wake.delivered'));
  assert.ok(report.results.find(item =>
    item.id === 'core.restart-after-delivery-replay' && item.status === 'pass'));
});

test('process conformance fails if restarted host cannot read persisted wake receipt', {
  timeout: 60000,
}, async () => {
  const adapter = createProcessHostAdapter({
    suppressRestoredReceipt: true,
  });
  const report = await runHostConformance(adapter, { profile: 'core' });
  assert.equal(report.passed, false);
  const failure = report.results.find(item =>
    item.id === 'core.restart-after-delivery-replay');
  assert.equal(failure?.status, 'fail');
  assert.match(failure.error ?? '', /durable store lost the completed wake receipt/);
  assert.ok(report.results.some(item =>
    item.id === 'core.once-threshold' && item.status === 'pass'));
});
