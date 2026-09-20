import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  buildGenericRuntimeWakePacket,
  createSignedRuntimeWakeDeliverer,
  readRuntimeWakeTargets,
} from '../scripts/lib/generic-runtime-wake.mjs';
import { canonicalWakeJson } from '../scripts/lib/wake-signature.mjs';

test('generic composite wake is signed and targets an arbitrary runtime', async () => {
  const match = {
    matchId: 'match_1', triggerId: 'trigger_1', triggerVersion: '1',
    updatedAt: '2026-09-18T12:00:00.000Z',
    sourceEvents: [{ serverId: 'github', sourceEventId: 'issue_1', eventName: 'github.issue.opened', traceId: 'trace_1' },
      { serverId: 'gmail', sourceEventId: 'mail_1', eventName: 'email.received', traceId: 'trace_2' }],
  };
  const packet = buildGenericRuntimeWakePacket({
    wakeId: 'wake_1', match,
    definition: { target: { runtime: 'mini-agent', kind: 'task', id: 'report' } },
  });
  assert.equal(packet.target.runtime, 'mini-agent');
  assert.equal(packet.source_event_refs.length, 2);
  assert.equal('data' in packet.source_event_refs[0], false);

  const secret = 'a'.repeat(32);
  const deliver = createSignedRuntimeWakeDeliverer({
    url: 'https://runtime.example/wake', secret, now: () => 12345,
    fetchFn: async (_url, options) => {
      const expected = createHmac('sha256', secret)
        .update(`12345.${canonicalWakeJson(packet)}`)
        .digest('hex');
      assert.equal(options.headers['X-Event-Wake-Signature'], `v1=${expected}`);
      assert.equal(JSON.parse(options.body).target.runtime, 'mini-agent');
      return { ok: true, json: async () => ({ runtimeReceiptId: 'mini:wake_1' }) };
    },
  });
  assert.equal((await deliver(packet)).runtimeReceiptId, 'mini:wake_1');
});

test('runtime targets reject arbitrary HTTP callbacks and weak secrets', () => {
  assert.throws(() => readRuntimeWakeTargets(JSON.stringify({ mini: { url: 'http://example.com/wake', secret: 'a'.repeat(32) } })));
  assert.throws(() => readRuntimeWakeTargets(JSON.stringify({ mini: { url: 'https://example.com/wake', secret: 'short' } })));
  assert.equal(readRuntimeWakeTargets(JSON.stringify({ mini: { url: 'http://localhost:3000/wake', secret: 'a'.repeat(32) } })).size, 1);
});
