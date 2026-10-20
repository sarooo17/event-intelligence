import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  PostgresEventStore, verifyAuditProofWindow,
} from '../scripts/lib/postgres-event-store.mjs';

const url = process.env.POSTGRES_URL;
const pg = url ? await import('pg') : null;
const Pool = pg?.Pool ?? pg?.default?.Pool;
const integration = url ? test : test.skip;

function audit(i) {
  return {
    auditId: 'audit-window-' + i,
    traceId: 'trace-window',
    timestamp: '2026-10-19T00:00:00.000Z',
    kind: 'trigger.created',
    entityType: 'trigger',
    entityId: 'trigger-window-' + i,
    details: { revision: i },
  };
}

integration('PostgreSQL bounded audit proofs verify across restart, tenants and tampering without history deletion', async () => {
  const prefix = 'ei_audproof_' + randomBytes(5).toString('hex');
  const poolA = new Pool({ connectionString: url, max: 4 });
  const poolB = new Pool({ connectionString: url, max: 4 });
  const a = new PostgresEventStore({
    pool: poolA, dispatchPoolIdentity: poolA, tablePrefix: prefix, scopeId: 'audit-tenant-A',
  });
  const reader = new PostgresEventStore({
    pool: poolB, dispatchPoolIdentity: poolB, tablePrefix: prefix, scopeId: 'audit-tenant-A',
  });
  const other = new PostgresEventStore({
    pool: poolB, dispatchPoolIdentity: poolB, tablePrefix: prefix, scopeId: 'audit-tenant-B',
  });
  try {
    await Promise.all([a.init(), reader.init(), other.init()]);
    const emptyCheckpoint = await reader.getAuditCheckpoint();
    const empty = await reader.getAuditProofWindow({checkpoint: emptyCheckpoint, limit: 2});
    assert.equal(empty.endSequence, -1);
    assert.equal(empty.headHash, null);
    assert.deepEqual(empty.records, []);
    assert.equal(await verifyAuditProofWindow(empty, {
      trustedCheckpoint: emptyCheckpoint, trustedAfterSequence: -1,
      trustedPreviousHash: null, trustedLimit: 2,
    }), true);

    await Promise.all([0,1,2,3,4].map(i => (i % 2 ? reader : a).appendAudit(audit(i))));
    // appendAudit itself serializes scope-local ordering under an advisory
    // transaction lock even when invoked concurrently from separate pools.
    const all = await a.listAudit();
    assert.equal(all.length, 5);
    assert.deepEqual(all.map(x=>x.sequence),[0,1,2,3,4]);
    assert.equal(await a.verifyAudit(), true);
    await other.appendAudit(audit('tenant-B'));
    assert.equal((await other.listAudit()).length, 1);
    const checkpoint = await a.getAuditCheckpoint();
    const otherCheckpoint = await other.getAuditCheckpoint();
    assert.equal(checkpoint.endSequence, 4);
    assert.equal(checkpoint.firstHash, all[0].hash);
    assert.equal(checkpoint.headHash, all[4].hash);

    const first = await a.getAuditProofWindow({checkpoint, limit: 2});
    assert.deepEqual(first.records.map(x=>x.sequence), [0,1]);
    assert.equal(first.hasMore, true);
    assert.equal(first.previousHash, null);
    assert.equal(first.headHash, all[1].hash);
    assert.equal(await verifyAuditProofWindow(first, {
      trustedCheckpoint: checkpoint, trustedAfterSequence: -1,
      trustedPreviousHash: null, trustedLimit: 2,
    }), true);

    // The second proof must be verified using an *externally pinned*
    // anchor from the preceding segment, not an anchor chosen by the DB.
    const next = await reader.getAuditProofWindow({
      checkpoint, afterSequence: first.endSequence, limit: 2,
    });
    assert.deepEqual(next.records.map(x=>x.sequence), [2,3]);
    assert.equal(next.previousHash, first.headHash);
    assert.equal(await verifyAuditProofWindow(next, {
      trustedAfterSequence: first.endSequence,
      trustedPreviousHash: first.headHash, trustedCheckpoint: checkpoint, trustedLimit: 2,
    }), true);
    const tail = await reader.getAuditProofWindow({
      checkpoint, afterSequence: next.endSequence, limit: 2,
    });
    assert.deepEqual(tail.records.map(x=>x.sequence), [4]);
    assert.equal(tail.hasMore, false);
    assert.equal(await verifyAuditProofWindow(tail, {
      trustedAfterSequence: next.endSequence,
      trustedPreviousHash: next.headHash, trustedCheckpoint: checkpoint, trustedLimit: 2,
    }), true);
    const final = await reader.getAuditProofWindow({
      checkpoint, afterSequence: tail.endSequence,
    });
    assert.deepEqual(final.records, []);
    assert.equal(final.headHash, tail.headHash);
    assert.equal(await verifyAuditProofWindow(final, {
      trustedAfterSequence: tail.endSequence,
      trustedPreviousHash: tail.headHash, trustedCheckpoint: checkpoint, trustedLimit: 100,
    }), true);
    assert.equal((await a.listAudit()).length, 5,
      'exporting proof windows must never prune source audit history');
    assert.equal((await other.getAuditProofWindow({checkpoint:otherCheckpoint, limit:2})).records.length, 1);

    const clone = obj=>structuredClone(obj);
    const flipped = clone(next);
    flipped.records[0].details = { revision: 999 };
    assert.equal(await verifyAuditProofWindow(flipped, {
      trustedAfterSequence: first.endSequence,
      trustedPreviousHash: first.headHash, trustedCheckpoint: checkpoint, trustedLimit: 2,
    }), false, 'tampered payload must invalidate canonical record hash');
    const missing = clone(next);
    missing.records.shift();
    assert.equal(await verifyAuditProofWindow(missing, {
      trustedAfterSequence: first.endSequence,
      trustedPreviousHash: first.headHash, trustedCheckpoint: checkpoint, trustedLimit: 2,
    }), false, 'skipped audit sequence is not a valid bounded proof');
    const switched = clone(next);
    switched.records.reverse();
    assert.equal(await verifyAuditProofWindow(switched, {
      trustedAfterSequence: first.endSequence,
      trustedPreviousHash: first.headHash, trustedCheckpoint: checkpoint, trustedLimit: 2,
    }), false);
    assert.equal(await verifyAuditProofWindow(next, {
      trustedAfterSequence: first.endSequence,
      trustedPreviousHash: 'untrusted-external-anchor', trustedCheckpoint: checkpoint, trustedLimit: 2,
    }), false);
    assert.equal(await verifyAuditProofWindow(next, {
      trustedAfterSequence: first.endSequence,
      trustedPreviousHash: first.headHash, trustedCheckpoint: otherCheckpoint, trustedLimit: 2,
    }), false, 'externally pinned scope prevents proof reuse across tenants');
    const shortened = clone(tail);
    shortened.records = [];
    shortened.endSequence = next.endSequence;
    shortened.headHash = next.headHash;
    shortened.hasMore = false;
    assert.equal(await verifyAuditProofWindow(shortened, {
      trustedCheckpoint: checkpoint, trustedAfterSequence: next.endSequence,
      trustedPreviousHash: next.headHash, trustedLimit: 2,
    }), false, 'externally pinned terminal checkpoint rejects hidden tail');
    const relabeled = clone(first);
    relabeled.scopeId = 'audit-tenant-B';
    assert.equal(await verifyAuditProofWindow(relabeled, {
      trustedCheckpoint: otherCheckpoint, trustedAfterSequence: -1,
      trustedPreviousHash: null, trustedLimit: 2,
    }), false, 'tenant relabeling must not bypass pinned genesis hash');
    assert.equal(await verifyAuditProofWindow(next), false,
      'verification MUST require an independently known predecessor anchor');

    for (const bad of [
      {limit: 0}, {limit: 1001}, {afterSequence: -2},
      {afterSequence: 0.5}, {limit: NaN},
    ]) {
      await assert.rejects(
        () => a.getAuditProofWindow({checkpoint, ...bad}),
        e=>e.code==='EVENT_INTELLIGENCE_AUDIT_PROOF_POLICY_INVALID',
      );
    }
    await assert.rejects(
      () => a.getAuditProofWindow({checkpoint,afterSequence: 999,limit: 1}),
      e=>e.code==='EVENT_INTELLIGENCE_AUDIT_PROOF_POLICY_INVALID',
    );

    // A malicious or damaged DB row is rejected *before* proof export,
    // not returned to an operator as a valid archive.
    await poolA.query(
      'UPDATE "' + prefix + '_history" SET payload=' +
      'jsonb_set(payload,\'{details,revision}\',\'999\'::jsonb)' +
      " WHERE scope_id=$1 AND kind='audit' AND payload->>'sequence'='2'",
      ['audit-tenant-A'],
    );
    await assert.rejects(
      () => reader.getAuditProofWindow({checkpoint,afterSequence: 1,limit: 2}),
      e=>e.code==='EVENT_INTELLIGENCE_AUDIT_PROOF_CHAIN_INVALID',
    );
    // Breaking the *last* row's JSON sequence must not cause it to be
    // silently excluded from page results. Physical history ID pagination
    // still returns it for validation (and rejects malformed records).
    await poolA.query(
      'UPDATE "' + prefix + '_history" SET payload=payload - $1' +
      " WHERE scope_id=$2 AND kind='audit' AND payload->>'sequence'='4'",
      ['sequence', 'audit-tenant-A'],
    );
    await assert.rejects(
      () => reader.getAuditProofWindow({checkpoint,afterSequence: 3,limit: 2}),
    );
    await assert.rejects(() => reader.verifyAudit(),
      'malformed retained audit row must fail closed during full-chain verification');
    assert.equal((await other.listAudit()).length, 1,
      'damage to tenant A cannot change tenant B');
  } finally {
    try {
      for (const suffix of ['metadata','leases','history','records','counters']) {
        await poolA.query(
          'DROP TABLE IF EXISTS "' + prefix + '_' + suffix + '" CASCADE',
        );
      }
    } finally {
      await Promise.allSettled([poolA.end(),poolB.end()]);
    }
  }
});
