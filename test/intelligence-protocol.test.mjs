import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AuditChain,
  assertTransition,
} from '../dist/src/intelligenceProtocol/index.js';

test('wake lifecycle accepts only current delivery transitions', () => {
  assert.doesNotThrow(() =>
    assertTransition('wake_queued', 'wake_delivered')
  );
  assert.doesNotThrow(() =>
    assertTransition('wake_queued', 'dead_letter')
  );
  assert.throws(
    () => assertTransition('wake_delivered', 'wake_queued'),
    /Invalid event-intelligence lifecycle transition/,
  );
});

test('audit chain is ordered, linked and tamper-evident', async () => {
  const audit = new AuditChain();

  await audit.append({
    auditId: 'audit_1',
    traceId: 'trace_audit',
    timestamp: '2026-09-18T06:30:00.000Z',
    kind: 'wake.queued',
    entityType: 'wake',
    entityId: 'wake_audit',
    toState: 'wake_queued',
  });

  await audit.append({
    auditId: 'audit_2',
    traceId: 'trace_audit',
    timestamp: '2026-09-18T06:30:01.000Z',
    kind: 'wake.delivered',
    entityType: 'wake',
    entityId: 'wake_audit',
    fromState: 'wake_queued',
    toState: 'wake_delivered',
  });

  assert.equal(await audit.verify(), true);

  const records = audit.list();
  assert.equal(records[1].previousHash, records[0].hash);
  assert.equal(records[0].sequence, 0);
  assert.equal(records[1].sequence, 1);
});
