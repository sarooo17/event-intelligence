// Test-only independent OS worker; no runtime exports or production side effects.
import { Pool } from 'pg';
import { PostgresEventStore } from '../../scripts/lib/postgres-event-store.mjs';
import { CompositeEventConsumer } from '../../scripts/lib/composite-event-consumer.mjs';
import { CompositeWakeCoordinator } from '../../scripts/lib/composite-wake-coordinator.mjs';
import { WakeRetryScheduler } from '../../scripts/lib/wake-retry-scheduler.mjs';
import { CompositeTriggerEngine } from '../../dist/src/composite/engine.js';

const {
  POSTGRES_URL, EI_MATCH_KILL_PREFIX: tablePrefix,
  EI_MATCH_KILL_SCOPE: scopeId, EI_MATCH_KILL_ROUND,
  EI_MATCH_KILL_MODE: mode, EI_MATCH_KILL_WORKER: workerId,
  EI_MATCH_KILL_MATCH_ID: persistedMatchId,
} = process.env;
const round = Number(EI_MATCH_KILL_ROUND);
const triggerId = 'os-match-before-wake-' + round;
const occurredAt = new Date(Date.parse('2026-10-18T10:00:00.000Z') + round * 1000).toISOString();
let storePool, hostPool;
let stage = 'configuration';
let hostCalls = 0;
const ack = value => process.send?.({ ...value, pid: process.pid });

try {
  if (!POSTGRES_URL || !/^ei_mwkill_[a-f0-9]{10}$/.test(tablePrefix ?? '') ||
      scopeId !== 'os-matched-tenant' ||
      !Number.isSafeInteger(round) || round < 0 || round > 100 ||
      !['persist-match-hold','contend-delivery'].includes(mode) ||
      !/^logical-(victim|peer-[ab])$/.test(workerId ?? '')) {
    throw new Error('invalid isolated OS matching fixture configuration');
  }
  storePool = new Pool({
    connectionString: POSTGRES_URL, max: 2, query_timeout: 5000,
    statement_timeout: 5000, connectionTimeoutMillis: 5000,
  });
  const store = new PostgresEventStore({ pool: storePool, tablePrefix, scopeId });
  stage = 'store-init';
  await store.init();
  const engine = new CompositeTriggerEngine(store);
  if (mode === 'persist-match-hold') {
    stage = 'mcp-ingest-before-wake';
    const consumer = new CompositeEventConsumer({ store, triggerEngine: engine });
    const result = await consumer.ingestMcpOccurrence({
      event: {
        eventId: 'os-matched-event-' + round, name: 'fixture.os.match.ready',
        timestamp: occurredAt, data: { round },
      },
      serverId: 'fixture-mcp-server',
      provider: 'fixture-mcp-source',
      traceId: 'os-matched-trace-' + round,
    });
    const matches = result.results.filter(row =>
      row.matched && row.match?.status === 'matched' &&
      row.triggerId === triggerId);
    if (matches.length !== 1 || result.deliveries.length !== 1 ||
        result.deliveries[0].status !== 'runtime_unconfigured') {
      throw new Error('expected exactly one durable MCP-derived match before wake');
    }
    const persisted = (await store.listTriggerMatches(triggerId))
      .find(row => row.matchId === matches[0].match.matchId);
    if (persisted?.status !== 'matched') throw new Error('match not persisted');
    ack({ type: 'matched', round, matchId: persisted.matchId });
    // Only parent SIGKILL can terminate this worker after durable match ACK.
    setInterval(() => {}, 60000);
  } else {
    stage = 'load-match';
    // The expected match ID is used ONLY to validate the discovered outcome.
    // The worker itself must discover orphaned durable matches through the
    // production retry scheduler, never by manually passing a saved match
    // to deliverMatched().
    if (!persistedMatchId) {
      throw new Error('missing expected match identity for post-recovery assertion');
    }
    hostPool = new Pool({
      connectionString: POSTGRES_URL, max: 2, query_timeout: 5000,
      statement_timeout: 5000, connectionTimeoutMillis: 5000,
    });
    const coordinator = new CompositeWakeCoordinator({
      store, triggerEngine: engine, workerId, leaseMs: 30000,
      now: () => new Date(occurredAt),
      deliverer: async packet => {
        hostCalls++;
        if (packet.trigger_match_id !== persistedMatchId ||
            packet.target.runtime !== 'fixture-host') {
          throw new Error('unexpected host continuation target or identity');
        }
        // This is a separate external-host *fixture ledger* (not an EI
        // transaction). Record every attempt BEFORE applying idempotency.
        await hostPool.query(
          'INSERT INTO "' + tablePrefix + '_host_attempts" ' +
          '(wake_id,worker_id) VALUES ($1,$2)',
          [packet.wake_id, workerId],
        );
        const receiptId = 'fixture-external:' + packet.wake_id;
        const result = await hostPool.query(
          'INSERT INTO "' + tablePrefix + '_host_effects" ' +
          '(wake_id,receipt_id) VALUES ($1,$2) ' +
          'ON CONFLICT (wake_id) DO NOTHING RETURNING receipt_id',
          [packet.wake_id, receiptId],
        );
        if (result.rowCount !== 1) {
          throw new Error('external fixture would have duplicated host work');
        }
        return { runtimeReceiptId: receiptId };
      },
    });
    stage = 'wait-for-concurrent-release';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        process.off('message', release);
        reject(new Error('parent did not release competing worker in time'));
      }, 8000);
      const release = msg => {
        if (msg?.type !== 'go') return;
        clearTimeout(timer);
        process.off('message', release);
        resolve();
      };
      process.on('message', release);
      ack({ type: 'ready', round, matchId: persistedMatchId });
    });
    stage = 'production-orphan-recovery';
    const scheduler = new WakeRetryScheduler({
      store,
      resolveCoordinator: runtime => runtime === 'fixture-host' ? coordinator : null,
      now: () => new Date(occurredAt),
      orphanReconcileIntervalMs: 1000,
    });
    const candidates = await scheduler.runDue();
    const outcomes = candidates.filter(row => row.matchId === persistedMatchId);
    if (outcomes.length !== 1 ||
        !['wake_delivered', 'delivery_in_progress'].includes(outcomes[0].status)) {
      throw new Error('scheduler did not recover exactly one committed match');
    }
    const reported = {
      type: 'completed', round, status: outcomes[0].status,
      matchId: persistedMatchId, wakeId: outcomes[0].wakeId ?? null,
      receiptId: null, hostCalls,
    };
    stage = 'close';
    await Promise.all([hostPool.end(), storePool.end()]);
    hostPool = null; storePool = null;
    ack(reported);
  }
} catch (error) {
  ack({
    type: 'failed', stage,
    code: typeof error?.code === 'string' ? error.code : 'EI_OS_MATCH_FIXTURE_FAILURE',
  });
  process.exitCode = 1;
  await Promise.allSettled([storePool?.end(), hostPool?.end()].filter(Boolean));
}
