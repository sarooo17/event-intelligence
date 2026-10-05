const REPORT_SCHEMA = 'event-intelligence.host-conformance.v2';

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
    await harness.close();
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
