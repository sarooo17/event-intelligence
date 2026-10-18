import assert from 'node:assert/strict';
import test from 'node:test';

import { snapshotUntrustedEventData, readOwnEventPath } from '../dist/src/protocol/ownPath.js';
import { mcpOccurrenceToCorrelatableEvent } from '../dist/src/mcpEvents/consumer.js';

const unsafe = error => error?.code === 'EVENT_UNTRUSTED_DATA_INVALID';
const occurrence = data => ({
  eventId: 'oversized-ingress-1',
  name: 'github.issue.updated',
  timestamp: '2026-10-18T11:00:00.000Z',
  data,
});
const source = { traceId: 'bytes-probe', serverId: 'fixture' };

test('a single oversized UTF-8 value fails before MCP occurrence hashing', async () => {
  const huge = 'x'.repeat(4 * 1024 * 1024 + 1);
  assert.throws(() => snapshotUntrustedEventData({ message: huge }), unsafe);
  await assert.rejects(mcpOccurrenceToCorrelatableEvent(
    occurrence({ message: huge }), source,
  ), unsafe);
});

test('aggregate multibyte strings and keys consume one shared snapshot budget', () => {
  // Each chunk is individually safe, but one decoded event is too large.
  const chunk = '🍀'.repeat(270000); // 1.08 MiB UTF-8
  assert.equal(snapshotUntrustedEventData({ text: '🍀'.repeat(50) }).text.length, 100);
  assert.throws(() => snapshotUntrustedEventData({
    first: chunk, second: chunk, third: chunk, fourth: chunk,
  }), unsafe);
  assert.throws(() => snapshotUntrustedEventData({
    nested: ['x'.repeat(900000), 'x'.repeat(900000),
      'x'.repeat(900000), 'x'.repeat(900000), 'x'.repeat(900000)],
  }), unsafe);
});

test('safe JSON semantics and escaped/prototype-looking own keys remain intact', () => {
  const input = JSON.parse('{"__proto__":{"tenant":"own"},"message":"safe","value":42}');
  const copied = snapshotUntrustedEventData(input);
  assert.equal(readOwnEventPath(copied, '__proto__.tenant'), 'own');
  assert.equal(copied.message, 'safe');
  assert.equal(copied.value, 42);
  assert.equal(Object.getPrototypeOf(copied), Object.prototype);
});

test('over-budget source never invokes nested accessor or Proxy traps', () => {
  let getterReads = 0;
  const hidden = {};
  Object.defineProperty(hidden, 'secret', {
    enumerable: true,
    get() { getterReads++; return 'secret'; },
  });
  assert.throws(() => snapshotUntrustedEventData({
    huge: 'A'.repeat(4 * 1024 * 1024 + 50),
    nested: hidden,
  }), unsafe);
  assert.equal(getterReads, 0);

  let traps = 0;
  const evil = new Proxy({ tenant: 'victim' }, {
    get() { traps++; return 'victim'; },
    ownKeys() { traps++; return ['tenant']; },
  });
  assert.throws(() => snapshotUntrustedEventData({ evil }), unsafe);
  assert.equal(traps, 0);
});
