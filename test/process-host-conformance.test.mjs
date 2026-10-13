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


test('process-host conformance catches sensitive evidence in child observations', {
  timeout: 60000,
}, async () => {
  const report = await runHostConformance(
    createProcessHostAdapter({ injectLeakedObservation: true }),
    { profile: 'core' },
  );
  assert.equal(report.passed, false);
  const failure = report.results.find(item =>
    item.id === 'observability.required-events');
  assert.equal(failure?.status, 'fail');
  assert.match(failure.error ?? '', /observability leaked event payload/);
  assert.equal(JSON.stringify(report).includes('ei-conformance-secret-probe'),
    false, 'IPC must forward a leak verdict, not raw secret-bearing metadata');
});

test('unnamed child observations cannot conceal an untrusted payload leak', {
  timeout: 60000,
}, async () => {
  const report = await runHostConformance(
    createProcessHostAdapter({ injectNamelessObservationLeak: true }),
    { profile: 'core' },
  );
  assert.equal(report.passed, false);
  const failure = report.results.find(item =>
    item.id === 'observability.required-events');
  assert.equal(failure?.status, 'fail');
  assert.match(failure.error ?? '', /observability leaked event payload/);
  assert.equal(JSON.stringify(report).includes('ei-conformance-secret-probe'),
    false);
});

test('timed-out process RPC kills worker and prevents later mutations', {
  timeout: 15000,
}, async () => {
  const adapter = createProcessHostAdapter({
    hangMethod: 'createTrigger',
    rpcTimeoutMs: 75,
  });
  const harness = await adapter.createHarness({ observability() {} });
  await assert.rejects(
    harness.createTrigger({
      triggerId: 'must-not-complete', threshold: 500, oneShot: true,
    }),
    /Conformance worker RPC timed out: createTrigger/,
  );
  await assert.rejects(
    harness.emitEvent({ eventId: 'after-timeout', value: 999 }),
    /Conformance worker unavailable/,
  );
  // close() still awaits child death and deletes the owned temporary state.
  await assert.rejects(harness.close(), /Conformance worker unavailable/);
});
