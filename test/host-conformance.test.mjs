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

test('conformance rejects a fresh delivery that reuses a completed wake identity', async () => {
  const faulty = {
    name: 'faulty-wake-id-identity-host',
    async createHarness(options) {
      const harness = await referenceHostAdapter.createHarness(options);
      const deliveries = harness.deliveries.bind(harness);
      return {
        ...harness,
        deliveries() {
          const rows = deliveries();
          const target = rows.filter(row =>
            row.triggerId === 'conformance-delivered-restart'
          );
          if (target.length < 2) return rows;
          // Fault injection: a fresh event has a distinct host receipt but
          // mistakenly shares the already-completed wake's durable identity.
          return rows.map(row =>
            row === target[1]
              ? { ...row, wakeId: target[0].wakeId }
              : row
          );
        },
      };
    },
  };
  const report = await runHostConformance(faulty, { profile: 'core' });
  assert.equal(report.passed, false, 'reused wake identity must fail conformance');
  const regression = report.results.find(
    result => result.id === 'core.restart-after-delivery-replay'
  );
  assert.equal(regression?.status, 'fail');
  assert.match(regression.error, /fresh delivery reused the previous durable wake identity/);
});

test('v3 conformance accepts resettable newest-first delivery observers', async () => {
  const adapter = {
    name: 'restart-reset-newest-first-host',
    async createHarness(options) {
      const harness = await referenceHostAdapter.createHarness(options);
      const originalDeliveries = harness.deliveries.bind(harness);
      const originalRestart = harness.restart.bind(harness);
      let baselineLength = 0;
      return {
        ...harness,
        async restart() {
          await originalRestart();
          // A new host process may keep its EI durable data yet expose only
          // new callback deliveries from its new in-process observer.
          baselineLength = originalDeliveries().length;
        },
        deliveries() {
          // The conformance contract never requires chronological order.
          return originalDeliveries().slice(baselineLength).reverse();
        },
      };
    },
  };
  const report = await runHostConformance(adapter, { profile: 'management' });
  assert.equal(report.passed, true, JSON.stringify(report, null, 2));
});

test('v3 conformance rejects empty fresh runtime receipt after restart', async () => {
  const faulty = {
    name: 'faulty-empty-fresh-receipt-host',
    async createHarness(options) {
      const harness = await referenceHostAdapter.createHarness(options);
      const originalDeliveries = harness.deliveries.bind(harness);
      return {
        ...harness,
        deliveries() {
          const rows = originalDeliveries();
          return rows.map((row) =>
            row.triggerId === 'conformance-delivered-restart' &&
              row.wakeId !== rows.find(x =>
                x.triggerId === 'conformance-delivered-restart'
              )?.wakeId
              ? { ...row, runtimeReceiptId: '' }
              : row
          );
        },
      };
    },
  };
  const report = await runHostConformance(faulty, { profile: 'core' });
  assert.equal(report.passed, false);
  const regression = report.results.find(
    result => result.id === 'core.restart-after-delivery-replay',
  );
  assert.equal(regression?.status, 'fail');
  assert.match(regression.error, /fresh delivery reused the previous host receipt identity/);
});
