import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_POSTGRES_TABLE_PREFIX_BYTES,
  PostgresEventStore,
} from '../scripts/lib/postgres-event-store.mjs';

const max = 63;
// Mirrors every PostgreSQL object suffix created by the store, including
// the new scoped orphan-recovery indexes. A new object must update this list.
const suffixes = [
  '_records', '_records_kind_idx', '_records_age_idx',
  '_records_orphan_status_idx', '_records_wake_match_idx',
  '_history', '_history_scope_kind_idx', '_history_key_idx',
  '_leases', '_leases_expiry_idx', '_counters', '_metadata',
];
const pool = {
  query() { throw new Error('constructor must not query DB'); },
  connect() { throw new Error('constructor must not connect to DB'); },
};

test('every emitted PostgreSQL identifier fits inside the 63-byte ceiling', () => {
  const expected = max - Math.max(...suffixes.map(suffix => Buffer.byteLength(suffix)));
  assert.equal(MAX_POSTGRES_TABLE_PREFIX_BYTES, expected,
    'prefix limit must be derived from the longest emitted object suffix');
  const prefix = 'a'.repeat(MAX_POSTGRES_TABLE_PREFIX_BYTES);
  const db = new PostgresEventStore({pool,tablePrefix:prefix});
  assert.equal(db.tablePrefix, prefix);
  for (const suffix of suffixes) {
    assert.ok(Buffer.byteLength(prefix + suffix) <= max, suffix);
    assert.ok(Buffer.byteLength(prefix + 'x' + suffix) > max ||
      Buffer.byteLength(suffix) < Math.max(...suffixes.map(x => Buffer.byteLength(x))),
      'prefix cannot be extended without overflowing a longest PostgreSQL identifier');
  }
  assert.equal(new Set(suffixes.map(suffix => prefix + suffix)).size,suffixes.length);
});

test('overlong PostgreSQL prefixes fail at construction, not silently truncated', () => {
  for(const length of [MAX_POSTGRES_TABLE_PREFIX_BYTES+1,55,63,64,128]){
    assert.throws(
      () => new PostgresEventStore({pool,tablePrefix:'x'.repeat(length)}),
      (error) => error.code === 'EVENT_INTELLIGENCE_POSTGRES_PREFIX_TOO_LONG',
    );
  }
  assert.throws(
    () => new PostgresEventStore({pool,tablePrefix:'not valid'}),
    /safe PostgreSQL identifier/,
  );
});
