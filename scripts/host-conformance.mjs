const REPORT_SCHEMA = 'event-intelligence.host-conformance.v3';

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new Error(`Host conformance adapter requires ${name}()`);
  }
}

function validateHarness(harness, profile) {
  if (!harness || typeof harness !== 'object') {
    throw new Error('createHarness() must return a harness object');
  }
  const methods = [
    'createTrigger',
    'emitEvent',
    'deliveries',
    'restart',
    'inspectTrigger',
    'readWakeReceipt',
    'close',
  ];
  if (profile === 'management') {
    methods.push(
      'listTriggers',
      'pauseTrigger',
      'resumeTrigger',
      'updateTrigger',
      'deleteTrigger',
    );
  }
  for (const method of methods) {
    assertFunction(harness[method], method);
  }
  return harness;
}

function deliveryCount(rows, triggerId) {
  return rows.filter((row) => row?.triggerId === triggerId).length;
}

async function runCase(id, execute) {
  const startedAt = Date.now();
  try {
    const detail = await execute();
    return Object.freeze({
      id,
      status: 'pass',
      durationMs: Date.now() - startedAt,
      ...(detail ? { detail } : {}),
    });
  } catch (error) {
    return Object.freeze({
      id,
      status: 'fail',
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Run the runtime-neutral EI host contract against an isolated host harness.
 *
 * The adapter owns all runtime-specific translation. The kit only uses a
 * canonical value-change source and inspects externally visible deliveries,
 * persisted trigger state and structured observability events.
 */
export async function runHostConformance(
  adapter,
  { throwOnFailure = false, profile = 'core' } = {},
) {
  if (!adapter || typeof adapter !== 'object') {
    throw new Error('Host conformance adapter is required');
  }
  assertFunction(adapter.createHarness, 'createHarness');
  if (!['core', 'management'].includes(profile)) {
    throw new Error('Host conformance profile must be "core" or "management"');
  }

  const observed = [];
  const harness = validateHarness(await adapter.createHarness({
    observability(event) {
      observed.push(event);
    },
    profile,
  }), profile);

  const results = [];
  try {
    results.push(await runCase('core.once-threshold', async () => {
      await harness.createTrigger({
        triggerId: 'conformance-once',
        threshold: 1000,
        oneShot: true,
      });

      await harness.emitEvent({
        eventId: 'once-below',
        value: 999,
        secretProbe: 'ei-conformance-secret-probe',
      });
      requireCondition(
        deliveryCount(await harness.deliveries(), 'conformance-once') === 0,
        'below-threshold event produced a delivery',
      );

      await harness.emitEvent({
        eventId: 'once-match',
        value: 1001,
        secretProbe: 'ei-conformance-secret-probe',
      });
      requireCondition(
        deliveryCount(await harness.deliveries(), 'conformance-once') === 1,
        'matching event did not produce exactly one delivery',
      );

    }));

    results.push(await runCase('core.replay-dedup', async () => {
      await harness.createTrigger({
        triggerId: 'conformance-replay',
        threshold: 1000,
        oneShot: false,
        maxFirings: 2,
      });

      await harness.emitEvent({
        eventId: 'replay-same-id',
        value: 1100,
        secretProbe: 'ei-conformance-secret-probe',
      });
      await harness.emitEvent({
        eventId: 'replay-same-id',
        value: 1100,
        secretProbe: 'ei-conformance-secret-probe',
      });

      requireCondition(
        deliveryCount(await harness.deliveries(), 'conformance-replay') === 1,
        'replayed event produced a duplicate delivery on a persistent trigger',
      );
      const state = await harness.inspectTrigger('conformance-replay');
      requireCondition(
        Number(state?.fireCount) === 1,
        `replayed event advanced fireCount to ${state?.fireCount}`,
      );
    }));

    results.push(await runCase('core.restart-after-delivery-replay', async () => {
      const triggerId = 'conformance-delivered-restart';
      const originalEvent = {
        eventId: 'delivered-before-restart',
        value: 1901,
        secretProbe: 'ei-conformance-secret-probe',
      };
      await harness.createTrigger({
        triggerId,
        threshold: 1900,
        oneShot: false,
        maxFirings: 2,
      });
      await harness.emitEvent(originalEvent);

      const before = (await harness.deliveries())
        .filter((entry) => entry?.triggerId === triggerId);
      requireCondition(before.length === 1, 'pre-restart event did not deliver exactly once');
      const firstReceipt = before[0]?.runtimeReceiptId;
      const firstWakeId = before[0]?.wakeId;
      requireCondition(
        typeof firstWakeId === 'string' && firstWakeId.length > 0,
        'first delivery did not return a stable wake ID',
      );
      requireCondition(
        typeof firstReceipt === 'string' && firstReceipt.length > 0,
        'first delivery did not return a stable host receipt identifier',
      );

      // Restart AFTER a successful external delivery. The same durable
      // source event must not produce an additional match, wake or receipt.
      await harness.restart();
      const durableReceipt = await harness.readWakeReceipt(firstWakeId);
      requireCondition(
        durableReceipt?.status === 'delivered' &&
          durableReceipt.runtimeReceiptId === firstReceipt,
        'restarted durable store lost the completed wake receipt',
      );
      // Hosts may clear their in-process observer history on restart and
      // may return rows in any order. Capture their actual post-restart
      // baseline rather than requiring the pre-restart row to remain visible.
      const baseline = (await harness.deliveries())
        .filter((entry) => entry?.triggerId === triggerId);
      // A restarted host may clear its observer (zero rows) or preserve the
      // historical delivery (one row). More rows imply a duplicate callback
      // during restart, which must never be mistaken for existing history.
      requireCondition(
        baseline.length <= 1 &&
          (baseline.length === 0 || (
            baseline[0]?.wakeId === firstWakeId &&
            baseline[0]?.runtimeReceiptId === firstReceipt
          )),
        'restart observer has duplicated or changed the completed delivery',
      );
      const identitySignature = (rows) => JSON.stringify(
        rows.map((entry) => [entry?.wakeId, entry?.runtimeReceiptId])
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      );
      const baselineIdentity = identitySignature(baseline);
      await harness.emitEvent(originalEvent);
      const replayed = (await harness.deliveries())
        .filter((entry) => entry?.triggerId === triggerId);
      requireCondition(
        identitySignature(replayed) === baselineIdentity,
        'delivered event replayed after restart or changed prior delivery identity',
      );
      const afterReplayState = await harness.inspectTrigger(triggerId);
      requireCondition(
        Number(afterReplayState?.fireCount) === 1,
        `replayed event advanced durable fireCount to ${afterReplayState?.fireCount}`,
      );

      // A fresh source event still activates the surviving trigger. This
      // prevents a test-only implementation from disabling all deliveries.
      await harness.emitEvent({
        eventId: 'delivered-after-restart-new',
        value: 1902,
        secretProbe: 'ei-conformance-secret-probe',
      });
      const afterNew = (await harness.deliveries())
        .filter((entry) => entry?.triggerId === triggerId);
      requireCondition(
        afterNew.length === baseline.length + 1,
        'fresh event was lost or added multiple deliveries after restart',
      );
      const isSameDelivery = (a, b) =>
        a?.wakeId === b?.wakeId && a?.runtimeReceiptId === b?.runtimeReceiptId;
      requireCondition(
        baseline.every((entry) => afterNew.some((row) => isSameDelivery(entry, row))),
        'fresh delivery removed or changed a prior observed delivery',
      );
      const freshRows = afterNew.filter((entry) =>
        !baseline.some((row) => isSameDelivery(entry, row)),
      );
      requireCondition(freshRows.length === 1,
        'fresh event did not produce one newly identifiable delivery');
      const freshDelivery = freshRows[0];
      requireCondition(
        typeof freshDelivery.wakeId === 'string' &&
          freshDelivery.wakeId.length > 0 &&
          freshDelivery.wakeId !== firstWakeId,
        'fresh delivery reused the previous durable wake identity',
      );
      requireCondition(
        typeof freshDelivery.runtimeReceiptId === 'string' &&
          freshDelivery.runtimeReceiptId.length > 0 &&
          freshDelivery.runtimeReceiptId !== firstReceipt,
        'fresh delivery reused the previous host receipt identity',
      );
      const afterNewState = await harness.inspectTrigger(triggerId);
      requireCondition(
        Number(afterNewState?.fireCount) === 2,
        `fresh event did not advance fireCount to two: ${afterNewState?.fireCount}`,
      );
    }));

    results.push(await runCase('core.restart-durability', async () => {
      await harness.createTrigger({
        triggerId: 'conformance-restart',
        threshold: 1000,
        oneShot: false,
        maxFirings: 2,
      });
      await harness.restart();

      await harness.emitEvent({
        eventId: 'restart-1',
        value: 1200,
        secretProbe: 'ei-conformance-secret-probe',
      });
      requireCondition(
        deliveryCount(await harness.deliveries(), 'conformance-restart') === 1,
        'trigger did not survive runtime restart',
      );
    }));

    results.push(await runCase('core.max-firings', async () => {
      await harness.emitEvent({
        eventId: 'restart-2',
        value: 1300,
        secretProbe: 'ei-conformance-secret-probe',
      });
      await harness.emitEvent({
        eventId: 'restart-3',
        value: 1400,
        secretProbe: 'ei-conformance-secret-probe',
      });

      requireCondition(
        deliveryCount(await harness.deliveries(), 'conformance-restart') === 2,
        'maxFirings=2 did not cap external deliveries at two',
      );

      const state = await harness.inspectTrigger('conformance-restart');
      requireCondition(Boolean(state), 'trigger state unavailable after firing');
      requireCondition(
        Number(state.fireCount) === 2,
        `expected fireCount=2, got ${state.fireCount}`,
      );
    }));

    if (profile === 'management') {
      results.push(await runCase('management.lifecycle', async () => {
        const triggerId = 'conformance-management';
        await harness.createTrigger({
          triggerId,
          threshold: 1000,
          oneShot: false,
          maxFirings: 5,
        });

        const listed = await harness.listTriggers();
        const initial = listed.find((entry) => entry?.triggerId === triggerId);
        requireCondition(Boolean(initial), 'created trigger missing from owner-scoped list');
        requireCondition(
          initial.status === 'active',
          `expected active trigger in list, got ${initial?.status}`,
        );

        await harness.pauseTrigger(triggerId);
        await harness.emitEvent({
          eventId: 'management-paused',
          value: 1500,
          secretProbe: 'ei-conformance-secret-probe',
        });
        requireCondition(
          deliveryCount(await harness.deliveries(), triggerId) === 0,
          'paused trigger produced an external delivery',
        );
        const paused = await harness.inspectTrigger(triggerId);
        requireCondition(
          paused?.status === 'paused',
          `expected paused status, got ${paused?.status}`,
        );

        await harness.resumeTrigger(triggerId);
        await harness.emitEvent({
          eventId: 'management-resumed',
          value: 1600,
          secretProbe: 'ei-conformance-secret-probe',
        });
        requireCondition(
          deliveryCount(await harness.deliveries(), triggerId) === 1,
          'resumed trigger did not deliver exactly once',
        );

        await harness.updateTrigger({
          triggerId,
          threshold: 2000,
        });
        const updated = await harness.inspectTrigger(triggerId);
        requireCondition(
          updated?.status === 'active',
          `updated trigger is not active: ${updated?.status}`,
        );

        await harness.emitEvent({
          eventId: 'management-old-threshold',
          value: 1700,
          secretProbe: 'ei-conformance-secret-probe',
        });
        requireCondition(
          deliveryCount(await harness.deliveries(), triggerId) === 1,
          'updated trigger still matched the superseded threshold',
        );

        await harness.emitEvent({
          eventId: 'management-new-threshold',
          value: 2100,
          secretProbe: 'ei-conformance-secret-probe',
        });
        requireCondition(
          deliveryCount(await harness.deliveries(), triggerId) === 2,
          'updated trigger did not match the new threshold',
        );

        await harness.deleteTrigger(triggerId);
        const deleted = await harness.inspectTrigger(triggerId);
        requireCondition(
          deleted?.status === 'deleted',
          `expected deleted status, got ${deleted?.status}`,
        );
        await harness.emitEvent({
          eventId: 'management-deleted',
          value: 2200,
          secretProbe: 'ei-conformance-secret-probe',
        });
        requireCondition(
          deliveryCount(await harness.deliveries(), triggerId) === 2,
          'deleted trigger produced an external delivery',
        );
      }));
    }

    results.push(await runCase('observability.required-events', async () => {
      const names = new Set(observed.map((event) => event?.event));
      for (const name of [
        'ei.trigger.created',
        'ei.match.matched',
        'ei.wake.delivered',
      ]) {
        requireCondition(
          names.has(name),
          `missing required observability event ${name}`,
        );
      }

      const serialized = JSON.stringify(observed);
      requireCondition(
        !serialized.includes('ei-conformance-secret-probe'),
        'observability leaked event payload content',
      );
    }));
  } finally {
    // A host cleanup error must not erase the conformance results already
    // observed. For a normal close the v3 report/case count stays unchanged.
    // Do not echo arbitrary host exception text: it may contain credentials
    // or untrusted payload fragments, and reports can be shared publicly.
    const startedAt = Date.now();
    try {
      await harness.close();
    } catch {
      results.push(Object.freeze({
        id: 'lifecycle.close',
        status: 'fail',
        durationMs: Date.now() - startedAt,
        error: 'Host conformance harness close() failed',
      }));
    }
  }

  const failed = results.filter((result) => result.status === 'fail');
  const report = Object.freeze({
    schema: REPORT_SCHEMA,
    profile,
    adapter: String(adapter.name ?? 'unnamed-host'),
    passed: failed.length === 0,
    summary: Object.freeze({
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
    }),
    results: Object.freeze(results),
    observability: Object.freeze({
      captured: observed.length,
      eventNames: Object.freeze([...new Set(
        observed.map((event) => event?.event).filter(Boolean),
      )].sort()),
    }),
  });

  if (throwOnFailure && !report.passed) {
    const error = new Error(
      `Event Intelligence host conformance failed: ${failed
        .map((item) => item.id)
        .join(', ')}`,
    );
    error.report = report;
    throw error;
  }

  return report;
}

export const HOST_CONFORMANCE_REPORT_SCHEMA = REPORT_SCHEMA;
