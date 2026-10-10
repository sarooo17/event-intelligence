import assert from 'node:assert/strict';
import test from 'node:test';
import { simulateTrigger } from '../scripts/lib/trigger-inspector.mjs';

const definition = {
  triggerId: 'clock-fixture',
  version: '1',
  clauses: [
    { id: 'signal', event: 'fixture.signal', serverId: 'fixture', where: [] },
  ],
  pattern: { root: { kind: 'event', ref: 'signal' } },
  withinMs: 60_000,
  target: { runtime: 'host', kind: 'task', id: 'test-only' },
};

test('empty-event simulation with startAt uses no wall clock and fully replays', async () => {
  const input = {
    definition,
    events: [],
    startAt: '2026-03-29T01:45:00+01:00',
    until: '2026-03-29T03:30:00+02:00',
  };
  const first = await simulateTrigger(input);
  const second = await simulateTrigger(input);
  assert.equal(first.isolated, true);
  assert.equal(first.evaluatedUntil, '2026-03-29T01:30:00.000Z');
  assert.deepEqual(first, second);
  assert.deepEqual(first.steps, []);
  assert.equal(first.inspection.match, null);
});

test('startAt anchors processing time ahead of earlier external event timestamps', async () => {
  const result = await simulateTrigger({
    definition,
    startAt: '2026-01-01T10:00:00.000Z',
    events: [{
      traceId: 'trace-1', sourceEventId: 'event-1',
      name: 'fixture.signal', serverId: 'fixture', provider: 'test',
      occurredAt: '2026-01-01T09:00:00.000Z',
      data: { external: 'not-authority' },
    }],
    until: '2026-01-01T10:01:00.000Z',
  });
  assert.equal(result.steps[0].processingTime, '2026-01-01T10:00:00.000Z');
  assert.equal(result.evaluatedUntil, '2026-01-01T10:01:00.000Z');
  assert.equal(JSON.stringify(result.inspection).includes('not-authority'), false);
});

test('invalid virtual-time boundaries reject before creating simulated state', async () => {
  for (const [input, code] of [
    [{ startAt: 'not-a-date' }, 'EVENT_SIMULATION_START_TIME_INVALID'],
    [{ startAt: '2026-10-10T09:00:00' }, 'EVENT_SIMULATION_START_TIME_INVALID'],
    [{ startAt: '2026-02-30T09:00:00Z' }, 'EVENT_SIMULATION_START_TIME_INVALID'],
    [{ startAt: '2026-01-01' }, 'EVENT_SIMULATION_START_TIME_INVALID'],
    [{ until: 'garbage' }, 'EVENT_SIMULATION_END_TIME_INVALID'],
    [{ until: '2026-10-10T09:00:00' }, 'EVENT_SIMULATION_END_TIME_INVALID'],
    [{ until: '2026-02-30T09:00:00Z' }, 'EVENT_SIMULATION_END_TIME_INVALID'],
    [{ startAt: '2026-01-02T00:00:00.000Z',
       until: '2026-01-01T00:00:00.000Z' },
     'EVENT_SIMULATION_TIME_RANGE_INVALID'],
  ]) {
    await assert.rejects(
      () => simulateTrigger({ definition, events: [], ...input }),
      error => error.code === code,
    );
  }
});
