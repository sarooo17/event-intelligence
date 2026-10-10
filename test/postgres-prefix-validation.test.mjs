import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_POSTGRES_TABLE_PREFIX_BYTES,
  PostgresEventStore,
} from '../scripts/lib/postgres-event-store.mjs';

const max = 63;
const suffixes = [
  '_records', '_records_kind_idx', '_history',
  '_history_scope_kind_idx', '_history_key_idx', '_leases',
  '_leases_expiry_idx', '_counters', '_metadata',
];
const pool = {
  query() { throw new Error('constructor must not query DB'); },
  connect() { throw new Error('constructor must not connect to DB'); },
};

test('every emitted PostgreSQL identifier fits inside the 63-byte ceiling', () => {
  assert.equal(MAX_POSTGRES_TABLE_PREFIX_BYTES, 40);
  const prefix = 'a'.repeat(MAX_POSTGRES_TABLE_PREFIX_BYTES);
  const db = new PostgresEventStore({pool,tablePrefix:prefix});
  assert.equal(db.tablePrefix, prefix);
  for(const suffix of suffixes) {
    assert.ok(Buffer.byteLength(prefix + suffix) <= max, suffix);
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
