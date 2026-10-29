import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import {
  createActivationDispatcher,
  createDeterministicReceiptId,
} from '../scripts/embedded-host-kit.mjs';

// An **example external-host** ledger, NOT an EI storage implementation.
// This file only runs against a real PostgreSQL server in the existing
// postgres-ha CI job. The test source is EI-maintained, not an independent
// third-party adapter or certification of any deployed host.
const url = process.env.POSTGRES_URL;
const pg = url ? await import('pg') : null;
const Pool = pg?.Pool ?? pg?.default?.Pool;
const integration = url ? test : test.skip;

const seed = {
  activationVersion: '2',
  wake: {
    wakeId: 'wake-271', status: 'queued', runtimeReceiptId: null,
    matchedAt: '2026-10-27T00:00:00.000Z',
  },
  target: { runtime: 'unrelated-app', kind: 'job', id: 'job-a' },
  trigger: {
    triggerId: 'trigger-271', version: '1', description: null,
    pattern: {
      version: '2', root: { kind: 'event', ref: 'event_1' },
      partitionBy: [],
      selection: {
        overlap: 'disallow', afterMatch: 'skipPastLast',
        maxMatchesPerEvent: 10,
      },
      execution: {
        maxCandidates: 512, maxSemanticEvaluations: 16,
        maxBufferedEvents: 10000,
      },
    },
    lifecycle: { oneShot: true, cooldownMs: 0, completeOnGoal: false },
  },
  continuation: {
    instruction: 'Wake the host work queue.',
    contextPolicy: { evidence: 'matched_events', maxEvents: 20, includeData: true },
  },
  match: {
    matchId: 'match-271', status: 'matched', partitionKey: null,
    openedAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
  },
  evidence: [],
  trust: {
    continuation: 'configured_trigger_instruction',
    evidence: 'untrusted_external_signal',
  },
};

function signal(targetId, wakeId = seed.wake.wakeId) {
  return {
    ...seed,
    target: { ...seed.target, id: targetId },
    wake: { ...seed.wake, wakeId },
  };
}

// Synchronize the *preflight reads* of separate connections so each sees
// "not yet delivered". Only the host database unique constraint can then
// prevent duplicate queue writes; createActivationDispatcher is not a lock.
function rendezvous(participants) {
  let arrived = 0;
  let release;
  const completed = new Promise(resolve => { release = resolve; });
  return {
    async arrive() {
      arrived++;
      if (arrived === participants) release();
      await completed;
    },
  };
}

function makeHost(pool, targetsTable, workTable, { barrier, failAfterCommit, beforeDelivery } = {}) {
  let shouldLoseAck = Boolean(failAfterCommit);
  const receiptId = async ({ activation }) => {
    // Host-owned authoritative scope mapping, NOT data from a received event
    // or a model/agent-provided tenant string.
    const rows = await pool.query(
      `SELECT scope_id FROM ${targetsTable} WHERE target_id = $1`,
      [activation.target.id],
    );
    if (rows.rowCount !== 1) throw new Error('HOST_TARGET_UNKNOWN');
    return createDeterministicReceiptId(
      'host-queue:' + rows.rows[0].scope_id, activation.wake.wakeId,
    );
  };
  const hasReceipt = async id => {
    const rows = await pool.query(
      `SELECT 1 FROM ${workTable} WHERE receipt_id = $1`, [id],
    );
    if (rows.rowCount === 0 && barrier) await barrier.arrive();
    return rows.rowCount > 0;
  };
  const resolveTarget = async target => {
    const rows = await pool.query(
      `SELECT scope_id, active FROM ${targetsTable} WHERE target_id = $1`,
      [target.id],
    );
    if (rows.rowCount !== 1 || !rows.rows[0].active) return null;
    return { targetId: target.id, scopeId: rows.rows[0].scope_id };
  };
  const deliver = async ({ activation, target, receiptId: id }) => {
    // Deliberately allow an adversarial test to revoke the host target AFTER
    // resolveTarget() reads active=true but BEFORE the authoritative effect.
    if (beforeDelivery) await beforeDelivery({ activation, target });

    // Authorize at the actual host effect boundary, not only at the
    // earlier resolveTarget() preflight. Lock the host-owned authorization
    // row in the SAME transaction that inserts the durable effect/receipt.
    // A competing revoke UPDATE takes this same row lock: whichever
    // transaction commits first is the clear authority linearization order.
    const client = await pool.connect();
    let inserted;
    try {
      await client.query('BEGIN');
      const authority = await client.query(
        `SELECT scope_id, active FROM ${targetsTable}
          WHERE target_id = $1 FOR UPDATE`,
        [target.targetId],
      );
      if (authority.rowCount !== 1 ||
          !authority.rows[0].active ||
          authority.rows[0].scope_id !== target.scopeId) {
        const error = new Error('Host target authorization revoked');
        error.code = 'HOST_TARGET_REVOKED';
        throw error;
      }
      inserted = await client.query(
        `INSERT INTO ${workTable}
          (receipt_id, target_id, scope_id, wake_id)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (receipt_id) DO NOTHING
          RETURNING receipt_id`,
        [id, target.targetId, target.scopeId, activation.wake.wakeId],
      );
      if (inserted.rowCount === 0) {
        const existing = await client.query(
          `SELECT target_id, scope_id, wake_id
             FROM ${workTable} WHERE receipt_id = $1`, [id],
        );
        assert.deepEqual(existing.rows[0], {
          target_id: target.targetId,
          scope_id: target.scopeId,
          wake_id: activation.wake.wakeId,
        }, 'host receipt must never be reused for another target/scope/wake');
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    if (shouldLoseAck) {
      shouldLoseAck = false;
      throw new Error('host simulated crash AFTER committed queue row BEFORE acknowledgment');
    }
    return { runtimeReceiptId: id, duplicate: inserted.rowCount === 0 };
  };
  return createActivationDispatcher({
    receiptId, hasReceipt, resolveTarget, deliver,
  });
}

integration('an external-host PostgreSQL ledger atomically deduplicates parallel wakes, scopes and replay', {
  timeout: 60000,
}, async t => {
  const suffix = randomBytes(6).toString('hex');
  const targets = '"ei_host271_targets_' + suffix + '"';
  const work = '"ei_host271_work_' + suffix + '"';
  let poolA = new Pool({ connectionString: url, max: 6 });
  const poolB = new Pool({ connectionString: url, max: 6 });
  try {
    await poolA.query(`CREATE TABLE ${targets} (
      target_id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE
    )`);
    await poolA.query(`CREATE TABLE ${work} (
      receipt_id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL REFERENCES ${targets}(target_id),
      scope_id TEXT NOT NULL,
      wake_id TEXT NOT NULL
    )`);
    await poolA.query(`INSERT INTO ${targets} (target_id, scope_id)
      VALUES ('job-a', 'tenant-a'), ('job-b', 'tenant-b'),
        ('revoked-job', 'tenant-a'), ('revocable-race', 'tenant-a')`);

    await t.test('two independent PG pools, eight concurrent deliveries => one durable host work row', async () => {
      const barrier = rendezvous(8);
      const a = makeHost(poolA, targets, work, { barrier });
      const b = makeHost(poolB, targets, work, { barrier });
      const activation = signal('job-a', 'wake-concurrent');
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        (i % 2 === 0 ? a : b)(
          { wake_id: activation.wake.wakeId }, activation,
        )));
      const ids = new Set(results.map(row => row.runtimeReceiptId));
      assert.equal(ids.size, 1);
      const rows = await poolA.query(
        `SELECT * FROM ${work} WHERE wake_id = $1`,
        ['wake-concurrent'],
      );
      assert.equal(rows.rowCount, 1);
      assert.equal(rows.rows[0].scope_id, 'tenant-a');
      assert.equal(rows.rows[0].target_id, 'job-a');
    });

    await t.test('identical EI wake IDs from different host scopes cannot cross-deduplicate', async () => {
      const a = makeHost(poolA, targets, work);
      const b = makeHost(poolB, targets, work);
      const one = signal('job-a', 'same-wake-across-scopes');
      const two = signal('job-b', 'same-wake-across-scopes');
      const [ra, rb] = await Promise.all([
        a({ wake_id: one.wake.wakeId, scope_id: 'forged-tenant-b' }, one),
        b({ wake_id: two.wake.wakeId, scope_id: 'forged-tenant-a' }, two),
      ]);
      assert.notEqual(ra.runtimeReceiptId, rb.runtimeReceiptId);
      const rows = await poolA.query(
        `SELECT scope_id, target_id FROM ${work} WHERE wake_id = $1 ORDER BY scope_id`,
        ['same-wake-across-scopes'],
      );
      assert.deepEqual(rows.rows, [
        { scope_id: 'tenant-a', target_id: 'job-a' },
        { scope_id: 'tenant-b', target_id: 'job-b' },
      ]);
    });

    await t.test('revocation committed after preflight but before host effect denies queued work', async () => {
      let releaseDelivery;
      let reachedPrecommit;
      const entered = new Promise(resolve => { reachedPrecommit = resolve; });
      const gate = new Promise(resolve => { releaseDelivery = resolve; });
      const dispatch = makeHost(poolA, targets, work, {
        beforeDelivery: async () => {
          reachedPrecommit();
          await gate;
        },
      });
      const activation = signal('revocable-race', 'wake-revoke-precommit');
      const pending = dispatch({ wake_id: activation.wake.wakeId }, activation);
      await entered;
      // Independent PostgreSQL pool commits host-side revocation while the
      // earlier target resolver had already returned active=true.
      await poolB.query(
        `UPDATE ${targets} SET active = FALSE WHERE target_id = 'revocable-race'`,
      );
      releaseDelivery();
      await assert.rejects(pending, error => error?.code === 'HOST_TARGET_REVOKED');
      const rows = await poolB.query(
        `SELECT receipt_id FROM ${work} WHERE wake_id = 'wake-revoke-precommit'`,
      );
      assert.equal(rows.rowCount, 0, 'revoked queued work must not commit a host effect or receipt');
    });

    await t.test('post-commit/pre-ack failure reconciles through host DB; new pool sees persisted receipt', async () => {
      const first = makeHost(poolA, targets, work, { failAfterCommit: true });
      const activation = signal('job-b', 'wake-ack-lost');
      const outcome = await first({ wake_id: activation.wake.wakeId }, activation);
      assert.equal(outcome.duplicate, true);
      await poolA.end();
      poolA = null;
      const restartPool = new Pool({ connectionString: url, max: 2 });
      try {
        const restarted = makeHost(restartPool, targets, work);
        const again = await restarted({ wake_id: activation.wake.wakeId }, activation);
        assert.equal(again.duplicate, true);
        assert.equal(again.runtimeReceiptId, outcome.runtimeReceiptId);
        const rows = await restartPool.query(
          `SELECT * FROM ${work} WHERE wake_id = $1`, ['wake-ack-lost'],
        );
        assert.equal(rows.rowCount, 1);
      } finally {
        await restartPool.end();
      }
    });

    await t.test('revocation prevents uncommitted target continuation', async () => {
      const dispatch = makeHost(poolB, targets, work);
      await poolB.query(
        `UPDATE ${targets} SET active = FALSE WHERE target_id = 'revoked-job'`,
      );
      const activation = signal('revoked-job', 'wake-revoked');
      await assert.rejects(
        dispatch({ wake_id: activation.wake.wakeId }, activation),
        e => e?.code === 'EVENT_ACTIVATION_TARGET_UNAVAILABLE',
      );
      const rows = await poolB.query(
        `SELECT receipt_id FROM ${work} WHERE wake_id = $1`,
        ['wake-revoked'],
      );
      assert.equal(rows.rowCount, 0);
    });
  } finally {
    // Separate host pools and a temporary host-owned schema. The EI engine
    // never touches these tables and no external service is modified.
    await poolB.query(`DROP TABLE IF EXISTS ${work}`).catch(() => {});
    await poolB.query(`DROP TABLE IF EXISTS ${targets}`).catch(() => {});
    await Promise.allSettled([poolA?.end(), poolB.end()]);
  }
});
