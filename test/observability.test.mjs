import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createObservabilityEmitter,
} from '../scripts/lib/observability.mjs';

test('observability emits structured events and strips sensitive metadata', async () => {
  const rows = [];
  const observer = createObservabilityEmitter((event) => rows.push(event), {
    now: () => new Date('2026-10-05T05:00:00.000Z'),
  });

  const emitted = await observer.emit({
    event: 'ei.wake.retry_scheduled',
    level: 'warn',
    traceId: 'trace-1',
    wakeId: 'wake-1',
    metadata: {
      safe: 'visible',
      token: 'must-not-leak',
      payload: { secret: 'must-not-leak' },
      nested: {
        instruction: 'must-not-leak',
        value: 42,
      },
    },
  });

  assert.equal(emitted, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].schema, 'event-intelligence.observability.v1');
  assert.equal(rows[0].event, 'ei.wake.retry_scheduled');
  assert.equal(rows[0].timestamp, '2026-10-05T05:00:00.000Z');
  assert.equal(rows[0].metadata.safe, 'visible');
  assert.equal(rows[0].metadata.nested.value, 42);
  assert.equal('token' in rows[0].metadata, false);
  assert.equal('payload' in rows[0].metadata, false);
  assert.equal('instruction' in rows[0].metadata.nested, false);
  assert.doesNotMatch(JSON.stringify(rows[0]), /must-not-leak/);
});

test('observability sink failures never affect runtime callers', async () => {
  const observer = createObservabilityEmitter(() => {
    throw new Error('logger unavailable');
  });
  assert.equal(
    await observer.emit({ event: 'ei.lifecycle.started', level: 'info' }),
    false,
  );
});

test('observability rejects events outside the EI namespace', async () => {
  const observer = createObservabilityEmitter(() => {});
  await assert.rejects(
    observer.emit({ event: 'runtime.started' }),
    /ei\.\*/,
  );
});
