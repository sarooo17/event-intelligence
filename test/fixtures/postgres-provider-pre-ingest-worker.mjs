// Real OS worker fixture for source delivery before durable EI ingestion.
// The outbox and host effects are test-owned PostgreSQL tables, not EI tables.
import { Pool } from 'pg';
import { PostgresEventStore } from '../../scripts/lib/postgres-event-store.mjs';
import { CompositeTriggerEngine } from '../../dist/src/composite/engine.js';
import { CompositeWakeCoordinator } from '../../scripts/lib/composite-wake-coordinator.mjs';
import { CompositeEventConsumer } from '../../scripts/lib/composite-event-consumer.mjs';

const { POSTGRES_URL: url, EI_SOURCE_PREFIX: prefix,
  EI_SOURCE_SCOPE: scopeId, EI_SOURCE_SEQUENCE: sequenceText,
  EI_SOURCE_MODE: mode, EI_SOURCE_WORKER: workerId } = process.env;
const sourceTable = '"' + prefix + '_provider_outbox"';
const effectsTable = '"' + prefix + '_host_effects"';
const attemptsTable = '"' + prefix + '_host_attempts"';
const source = {
  connectionId: 'provider-before-ingest-connection',
  serverId: 'isolated-provider-fixture',
  eventName: 'fixture.issue.changed',
  arguments: { repository: 'example/evidence' },
  deliveryMode: 'poll',
};
const sequence = Number(sequenceText);
let pool = null;
let upstreamPool = null;
let stage = 'configuration';

try {
  if (!url || !prefix || !scopeId || !workerId ||
      !Number.isSafeInteger(sequence) || sequence < 1 ||
      !['hold-before-ingest', 'recover', 'force-replay'].includes(mode)) {
    throw Object.assign(new Error('invalid provider fixture configuration'), {
      code: 'EI_PROVIDER_FIXTURE_CONFIG_INVALID',
    });
  }
  pool = new Pool({
    connectionString: url, max: 2,
    connectionTimeoutMillis: 5000, query_timeout: 5000,
    statement_timeout: 5000,
  });
  upstreamPool = new Pool({
    connectionString: url, max: 2,
    connectionTimeoutMillis: 5000, query_timeout: 5000,
    statement_timeout: 5000,
  });
  const store = new PostgresEventStore({ pool, tablePrefix: prefix, scopeId });
  stage = 'init';
  await store.init();

  stage = 'poll-provider';
  const polled = await upstreamPool.query(
    'SELECT sequence, event, acked FROM ' + sourceTable +
      ' WHERE sequence=$1',
    [sequence],
  );
  if (polled.rows.length !== 1 ||
      (mode !== 'force-replay' && polled.rows[0].acked)) {
    throw Object.assign(new Error('provider event unavailable for replay'), {
      code: 'EI_PROVIDER_EVENT_UNAVAILABLE',
    });
  }
  const event = polled.rows[0].event;
  if (event.eventId !== 'provider-occurrence-' + sequence) {
    throw Object.assign(new Error('provider event identity changed'), {
      code: 'EI_PROVIDER_IDENTITY_INVALID',
    });
  }

  if (mode === 'hold-before-ingest') {
    // An actual provider poll already returned this stable event to the
    // worker. There has been no EI ingest call nor cursor advancement.
    // Parent observes this checkpoint then SIGKILLs this OS process.
    process.send?.({
      type: 'provider-event-received', pid: process.pid,
      eventId: event.eventId, sequence,
    });
    setInterval(() => {}, 60000);
  } else {
    stage = 'ingest';
    let hostCalls = 0;
    const engine = new CompositeTriggerEngine(store);
    const coordinator = new CompositeWakeCoordinator({
      store, triggerEngine: engine, workerId,
      deliverer: async packet => {
        hostCalls++;
        if (!packet.wake_id || !packet.trigger_match_id) {
          throw Object.assign(new Error('invalid EI wake packet'), {
            code: 'EI_PROVIDER_WAKE_PACKET_INVALID',
          });
        }
        await upstreamPool.query(
          'INSERT INTO ' + attemptsTable +
          ' (wake_id, worker_id) VALUES ($1, $2)',
          [packet.wake_id, workerId],
        );
        const receiptId = 'provider-fixture-receipt:' + packet.wake_id;
        const written = await upstreamPool.query(
          'INSERT INTO ' + effectsTable +
          ' (wake_id, receipt_id) VALUES ($1, $2)' +
          ' ON CONFLICT (wake_id) DO NOTHING RETURNING receipt_id',
          [packet.wake_id, receiptId],
        );
        const saved = await upstreamPool.query(
          'SELECT receipt_id FROM ' + effectsTable + ' WHERE wake_id=$1',
          [packet.wake_id],
        );
        if (saved.rows[0]?.receipt_id !== receiptId) {
          throw Object.assign(new Error('host receipt mismatch'), {
            code: 'EI_PROVIDER_HOST_RECEIPT_INVALID',
          });
        }
        return { runtimeReceiptId: receiptId, duplicate: written.rowCount === 0 };
      },
    });
    const consumer = new CompositeEventConsumer({
      store, triggerEngine: engine, wakeCoordinator: coordinator,
    });
    const result = await consumer.ingestMcpOccurrence({
      event, serverId: source.serverId,
      provider: 'outbox-fixture',
      subscriptionArguments: source.arguments,
      traceId: 'provider:' + event.eventId,
    });
    if (result.results.filter(row => row.matched).length !== 1 ||
        result.deliveries.length !== 1) {
      throw Object.assign(new Error('replayed event failed to match'), {
        code: 'EI_PROVIDER_REPLAY_MATCH_MISSING',
      });
    }
    const delivery = result.deliveries[0];
    if (!delivery.wakeId || !delivery.runtimeReceiptId ||
        (mode === 'recover' && delivery.status !== 'wake_delivered') ||
        (mode === 'force-replay' && delivery.status !== 'already_fired')) {
      throw Object.assign(new Error('replayed wake state invalid'), {
        code: 'EI_PROVIDER_REPLAY_WAKE_INVALID',
      });
    }
    if (hostCalls !== (mode === 'recover' ? 1 : 0)) {
      throw Object.assign(new Error('unexpected host execution count'), {
        code: 'EI_PROVIDER_HOST_REDISPATCH',
      });
    }
    if (mode === 'recover') {
      stage = 'checkpoint';
      // Ack follows a successful durable wake and receipt, never just
      // provider receipt. Keep MCP client identity/cursor scope intact.
      const old = await store.getMcpClientState(
        source.connectionId, source.eventName, source.arguments,
      );
      if (old?.cursor !== 'cursor:' + (sequence - 1)) {
        throw Object.assign(new Error('unexpected original cursor'), {
          code: 'EI_PROVIDER_CURSOR_MISMATCH',
        });
      }
      await store.putMcpClientState({
        ...source, cursor: 'cursor:' + sequence, truncated: false,
      });
      await upstreamPool.query(
        'UPDATE ' + sourceTable + ' SET acked=true WHERE sequence=$1',
        [sequence],
      );
    }
    const receipt = await store.getWakeDelivery(delivery.wakeId);
    if (receipt?.status !== 'delivered' ||
        receipt.runtimeReceiptId !== delivery.runtimeReceiptId ||
        receipt.attemptCount !== 1) {
      throw Object.assign(new Error('EI delivery receipt missing'), {
        code: 'EI_PROVIDER_RECEIPT_NOT_DURABLE',
      });
    }
    await Promise.all([pool.end(), upstreamPool.end()]);
    pool = null; upstreamPool = null;
    process.send?.({
      type: mode === 'recover' ? 'recovered' : 'replayed',
      pid: process.pid, sequence, eventId: event.eventId,
      wakeId: delivery.wakeId, receiptId: delivery.runtimeReceiptId,
      status: delivery.status, hostCalls,
    });
  }
} catch (error) {
  process.send?.({
    type: 'failed', stage,
    code: typeof error?.code === 'string'
      ? error.code : 'EI_PROVIDER_FIXTURE_FAILED',
  });
  process.exitCode = 1;
  await Promise.allSettled([pool?.end(), upstreamPool?.end()].filter(Boolean));
}
