import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runHostConformance,
} from '../scripts/host-conformance.mjs';
import {
  referenceHostAdapter,
} from '../conformance/reference-host.mjs';

test('reference embedded host passes EI host conformance', async () => {
  const report = await runHostConformance(referenceHostAdapter, {
    profile: 'management',
  });
  assert.equal(report.schema, 'event-intelligence.host-conformance.v3');
  assert.equal(report.profile, 'management');
  assert.equal(report.passed, true, JSON.stringify(report, null, 2));
  assert.deepEqual(report.summary, {
    total: 7,
    passed: 7,
    failed: 0,
  });
  assert.ok(report.observability.eventNames.includes('ei.trigger.created'));
  assert.ok(report.observability.eventNames.includes('ei.match.matched'));
  assert.ok(report.observability.eventNames.includes('ei.wake.delivered'));
});

test('conformance catches a host that loses source-event dedup across restart', async () => {
  const regressed = {
    name: 'faulty-restart-replay-host',
    async createHarness(options) {
      const harness = await referenceHostAdapter.createHarness(options);
      const emit = harness.emitEvent.bind(harness);
      const restart = harness.restart.bind(harness);
      let didRestart = false;
      return {
        ...harness,
        async restart() {
          await restart();
          didRestart = true;
        },
        async emitEvent(input) {
          // Fault injection: simulate an adapter losing stable event identity
          // only after restart, turning replay into a brand-new event.
          const eventId = didRestart && input.eventId === 'delivered-before-restart'
            ? 'incorrectly-renamed-replay-event'
            : input.eventId;
          await emit({ ...input, eventId });
        },
      };
    },
  };
  const report = await runHostConformance(regressed, { profile: 'core' });
  assert.equal(report.passed, false, 'faulty restart replay must not pass');
  const regression = report.results.find(
    (result) => result.id === 'core.restart-after-delivery-replay',
  );
  assert.equal(regression?.status, 'fail');
  assert.match(regression.error, /replayed after restart|fireCount/);
});

test('conformance rejects a host missing durable wake receipts after restart', async () => {
  const regressed = {
    name: 'faulty-persisted-receipt-host',
    async createHarness(options) {
      const harness = await referenceHostAdapter.createHarness(options);
      const restart = harness.restart.bind(harness);
      let didRestart = false;
      return {
        ...harness,
        async restart() {
          await restart();
          didRestart = true;
        },
        async readWakeReceipt(wakeId) {
          // Fault injection: no persisted receipt is recoverable after
          // restart although the external deliveries closure survived.
          return didRestart ? null : harness.readWakeReceipt(wakeId);
        },
      };
    },
  };
  const report = await runHostConformance(regressed, { profile: 'core' });
  assert.equal(report.passed, false, 'lost receipt must fail conformance');
  const regression = report.results.find(
    (result) => result.id === 'core.restart-after-delivery-replay',
  );
  assert.equal(regression?.status, 'fail');
  assert.match(regression.error, /durable store lost the completed wake receipt/);
});
