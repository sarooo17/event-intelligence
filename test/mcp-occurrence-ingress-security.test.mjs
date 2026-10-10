import assert from 'node:assert/strict';
import test from 'node:test';
import { mcpOccurrenceToCorrelatableEvent } from '../dist/src/mcpEvents/consumer.js';
import { sha256Hex } from '../dist/src/intelligenceProtocol/canonical.js';

const validOccurrence = (data) => ({
  eventId: 'evt-1',
  name: 'github.issue.updated',
  timestamp: '2026-10-10T12:00:00.000Z',
  data,
});
const host = {
  traceId: 'trace-1',
  provider: 'fixture',
  serverId: 'server-1',
};

test('MCP occurrence hashes only normalized safe data', async () => {
  const clean = { title: 'Issue reopened', count: 1, tags: ['bug'] };
  const result = await mcpOccurrenceToCorrelatableEvent(
    validOccurrence(clean), host,
  );
  assert.equal(result.name, 'github.issue.updated');
  assert.equal(result.data.title, 'Issue reopened');
  assert.equal(result.payloadHash, await sha256Hex(clean));
});

test('MCP converter rejects getter payloads before hashing or parsing', async () => {
  let reads = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'tenant', {
    enumerable: true,
    get() { reads++; return 'victim'; },
  });
  await assert.rejects(
    mcpOccurrenceToCorrelatableEvent(validOccurrence(hostile), host),
    error => error.code === 'EVENT_UNTRUSTED_DATA_INVALID',
  );
  assert.equal(reads, 0);
});

test('MCP converter rejects nested and outer proxies with zero traps', async () => {
  let traps = 0;
  const nested = new Proxy({ tenant: 'victim' }, {
    ownKeys() { traps++; return ['tenant']; },
    get() { traps++; return 'victim'; },
    getOwnPropertyDescriptor() {
      traps++;
      return { configurable: true, enumerable: true, value: 'victim' };
    },
  });
  await assert.rejects(
    mcpOccurrenceToCorrelatableEvent(
      validOccurrence({ account: nested }), host,
    ),
    error => error.code === 'EVENT_UNTRUSTED_DATA_INVALID',
  );
  await assert.rejects(
    mcpOccurrenceToCorrelatableEvent(
      new Proxy(validOccurrence({ ok: true }), {
        get() { traps++; return 'forged'; },
        ownKeys() { traps++; return ['eventId']; },
      }), host,
    ),
    error => error.code === 'EVENT_UNTRUSTED_DATA_INVALID',
  );
  assert.equal(traps, 0, 'hash and schema must not invoke provider traps');
});

test('MCP converter rejects unsafe subscription arguments before hashing', async () => {
  let reads = 0;
  const argumentsWithGetter = {};
  Object.defineProperty(argumentsWithGetter, 'tenant', {
    enumerable: true,
    get() { reads++; return 'victim'; },
  });
  await assert.rejects(
    mcpOccurrenceToCorrelatableEvent(
      validOccurrence({ safe: true }),
      { ...host, subscriptionArguments: argumentsWithGetter },
    ),
    error => error.code === 'EVENT_UNTRUSTED_DATA_INVALID',
  );
  assert.equal(reads, 0);
});
