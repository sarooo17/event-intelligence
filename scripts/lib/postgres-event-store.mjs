import * as z from 'zod/v4';
import { mcpGapSnapshot } from '../../dist/src/composite/gapFingerprint.js';
import { safeMcpSourceArguments } from './mcp-safe-arguments.mjs';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { verifyAuditProofWindow } from './audit-proof-window.mjs';
export { verifyAuditProofWindow } from './audit-proof-window.mjs';
import {
  AuditChain,
  McpEventOccurrenceSchema,
  parseAuditRecord,
  parseCompositeTriggerDefinition,
  parseDerivedEventRecord,
  parseTriggerMatchRecord,
} from '../../dist/src/intelligenceProtocol/index.js';
import { validateHistoryWindowLimit } from './history-window.mjs';
import { assertWakeClaimGeneration } from './wake-claim-generation.mjs';
import { assertPostgresSchemaShape } from './postgres-schema-shape.mjs';
import {
  PATTERN_V2_SIGNATURE_CONTRACT_VERSION,
  PATTERN_V2_SIGNATURE_COMPONENT,
  patternV2SignatureError,
} from './pattern-v2-signature-contract.mjs';
import {
  DEFAULT_EVENT_SCOPE_ID,
  normalizeEventScopeId,
} from './persistent-event-store.mjs';

// Context is scoped to one fenced async callback, never persisted or shared
// with unrelated tenant/host requests. It allows the lifecycle finalizer to
// reuse its own trigger authorization lock without deadlocking itself.
const dispatchContext = new AsyncLocalStorage();
const poolFenceSlots = new WeakMap();

async function withPoolFenceCapacity(pool, capacity, run) {
  let state = poolFenceSlots.get(pool);
  if (!state) {
    state = { active: 0, waiters: [] };
    poolFenceSlots.set(pool, state);
  }
  // Admit at most maxPool-2 fence sessions in this Node process so at
  // least two PG connections remain for callback lookups and lifecycle
  // mutations, rather than filling the pool with lock waiters.
  if (state.active >= capacity) {
    await new Promise(resolve => state.waiters.push(resolve));
  }
  state.active++;
  try {
    return await run();
  } finally {
    state.active--;
    state.waiters.shift()?.();
  }
}

const POSTGRES_OBJECT_SUFFIXES = Object.freeze([
  '_records',
  '_records_kind_idx',
  '_records_age_idx',
  '_records_orphan_status_idx',
  '_records_wake_match_idx',
  '_history',
  '_history_scope_kind_idx',
  '_history_key_idx',
  '_leases',
  '_leases_expiry_idx',
  '_counters',
  '_metadata',
]);

// PostgreSQL normally truncates identifiers beyond NAMEDATALEN-1 (63 bytes).
// If suffixes are truncated, tables/indexes from distinct EI installations
// may collide silently despite having independently valid table prefixes.
const MAX_POSTGRES_IDENTIFIER_BYTES = 63;
export const MAX_POSTGRES_TABLE_PREFIX_BYTES =
  MAX_POSTGRES_IDENTIFIER_BYTES -
  Math.max(...POSTGRES_OBJECT_SUFFIXES.map((suffix) => Buffer.byteLength(suffix)));

export const POSTGRES_PERSISTED_SCHEMA_VERSION = 1;

export const POSTGRES_STORE_CAPABILITIES = Object.freeze({
  version: '1',
  sharedState: 'strong',
  scopeIsolation: 'strong',
  wakeClaims: 'distributed-atomic',
  partitionLeases: 'distributed-atomic',
  mutableCompaction: 'database-managed',
  readModel: 'postgres-authoritative',
});

function ident(value, label) {
  const v = String(value || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(v)) {
    throw new Error(label + ' must be a safe PostgreSQL identifier');
  }
  return v;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function mcpStateKey(connectionId, eventName, args = {}) {
  return String(connectionId) + '::' + String(eventName) + '::' +
    JSON.stringify(canonical(safeMcpSourceArguments(args)));
}

function defaultTriggerState(triggerId, version) {
  return {
    triggerId: String(triggerId),
    version: String(version),
    status: 'active',
    updatedAt: null,
    actor: null,
    owner: null,
    connectionIds: [],
    fireCount: 0,
    lastFiredAt: null,
    revision: 0,
  };
}

function leaseRow(row) {
  if (!row) return null;
  return {
    partitionKey: String(row.lease_key),
    workerId: String(row.owner_id),
    leaseUntil: new Date(row.lease_until).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    status: 'active',
  };
}

export class PostgresEventStore {
  constructor({
    pool,
    scopeId = DEFAULT_EVENT_SCOPE_ID,
    tablePrefix = 'event_intelligence',
    ownsPool = false,
    adoptUnversionedSchema = false,
  } = {}) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
      throw new Error(
        'PostgresEventStore requires a pg-compatible pool with query() and connect()',
      );
    }
    this.pool = pool;
    this.scopeId = normalizeEventScopeId(scopeId);
    // Validate the full length before ident() rejects 64+ characters
    // generically. All overlong otherwise-valid identifiers receive the
    // specific fail-closed error, including values beyond PostgreSQL's 63.
    const candidatePrefix = String(tablePrefix || '').trim();
    if (Buffer.byteLength(candidatePrefix) > MAX_POSTGRES_TABLE_PREFIX_BYTES) {
      const error = new Error(
        'tablePrefix is too long for PostgreSQL tables and indexes; ' +
        'maximum ' + MAX_POSTGRES_TABLE_PREFIX_BYTES + ' ASCII bytes',
      );
      error.code = 'EVENT_INTELLIGENCE_POSTGRES_PREFIX_TOO_LONG';
      throw error;
    }
    this.tablePrefix = ident(candidatePrefix, 'tablePrefix');
    this.ownsPool = ownsPool === true;
    this.adoptUnversionedSchema = adoptUnversionedSchema === true;
    this.initialized = false;
    this.scopeStores = new Map();
    this.records = '"' + this.tablePrefix + '_records"';
    this.history = '"' + this.tablePrefix + '_history"';
    this.leases = '"' + this.tablePrefix + '_leases"';
    this.counters = '"' + this.tablePrefix + '_counters"';
    this.metadata = '"' + this.tablePrefix + '_metadata"';
  }

  storeCapabilities() {
    return { ...POSTGRES_STORE_CAPABILITIES };
  }

  async init() {
    if (!this.initialized) {
      await this.tx(async (client) => {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [this.tablePrefix + ':schema'],
        );
        // Only new, empty installations may build the index transactionally.
        // Never auto-build an index on a populated deployment at startup:
        // CREATE INDEX blocks writers, and CONCURRENTLY while other workers
        // initialize can deadlock with open transactions/snapshots.
        const existing = await client.query('SELECT to_regclass($1) AS relation', [
          '"' + this.tablePrefix + '_records"',
        ]);
        const freshRecords = !existing.rows[0]?.relation;
        for (const statement of [
          'CREATE TABLE IF NOT EXISTS ' + this.records + ' (' +
            'scope_id TEXT NOT NULL, kind TEXT NOT NULL, record_key TEXT NOT NULL,' +
            'payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),' +
            'PRIMARY KEY (scope_id, kind, record_key))',
          'CREATE INDEX IF NOT EXISTS ' + this.tablePrefix +
            '_records_kind_idx ON ' + this.records + ' (scope_id, kind)',
          'CREATE TABLE IF NOT EXISTS ' + this.history + ' (' +
            'history_id BIGSERIAL PRIMARY KEY, scope_id TEXT NOT NULL, kind TEXT NOT NULL,' +
            'record_key TEXT, payload JSONB NOT NULL,' +
            'created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())',
          'CREATE INDEX IF NOT EXISTS ' + this.tablePrefix +
            '_history_scope_kind_idx ON ' + this.history +
            ' (scope_id, kind, history_id)',
          'CREATE INDEX IF NOT EXISTS ' + this.tablePrefix +
            '_history_key_idx ON ' + this.history +
            ' (scope_id, kind, record_key, history_id)',
          'CREATE TABLE IF NOT EXISTS ' + this.leases + ' (' +
            'scope_id TEXT NOT NULL, lease_kind TEXT NOT NULL, lease_key TEXT NOT NULL,' +
            'owner_id TEXT NOT NULL, lease_until TIMESTAMPTZ NOT NULL,' +
            'updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),' +
            'PRIMARY KEY (scope_id, lease_kind, lease_key))',
          'CREATE INDEX IF NOT EXISTS ' + this.tablePrefix +
            '_leases_expiry_idx ON ' + this.leases +
            ' (scope_id, lease_kind, lease_until)',
          'CREATE TABLE IF NOT EXISTS ' + this.counters + ' (' +
            'scope_id TEXT NOT NULL, name TEXT NOT NULL, value BIGINT NOT NULL,' +
            'PRIMARY KEY (scope_id, name))',
          'CREATE TABLE IF NOT EXISTS ' + this.metadata + ' (' +
            'component TEXT PRIMARY KEY, version INTEGER NOT NULL,' +
            'adopted_from TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())',
        ]) {
          await client.query(statement);
        }
        await assertPostgresSchemaShape(client, this.tablePrefix);
        // Under the same advisory transaction lock as DDL, require a known
        // persisted contract BEFORE exposing the store to workers. Unknown
        // versions or unversioned nonempty state must never be reinterpreted.
        const current = await client.query(
          'SELECT version FROM ' + this.metadata +
          ' WHERE component = $1 FOR UPDATE',
          ['store'],
        );
        if (current.rows.length) {
          const found = Number(current.rows[0].version);
          if (found !== POSTGRES_PERSISTED_SCHEMA_VERSION) {
            const error = new Error(
              'Event Intelligence PostgreSQL schema version is incompatible; ' +
              'found ' + found + ', supported ' + POSTGRES_PERSISTED_SCHEMA_VERSION,
            );
            error.code = 'EVENT_INTELLIGENCE_POSTGRES_SCHEMA_INCOMPATIBLE';
            throw error;
          }
        } else {
          const counts = await client.query(
            'SELECT ' +
              'EXISTS(SELECT 1 FROM ' + this.records + ' LIMIT 1) AS records, ' +
              'EXISTS(SELECT 1 FROM ' + this.history + ' LIMIT 1) AS history, ' +
              'EXISTS(SELECT 1 FROM ' + this.leases + ' LIMIT 1) AS leases, ' +
              'EXISTS(SELECT 1 FROM ' + this.counters + ' LIMIT 1) AS counters',
          );
          const hasLegacyState = Object.values(counts.rows[0] ?? {})
            .some((value) => value === true);
          if (hasLegacyState && !this.adoptUnversionedSchema) {
            const error = new Error(
              'Unversioned Event Intelligence PostgreSQL data exists. ' +
              'Take a verified backup before explicitly adopting the existing schema.',
            );
            error.code = 'EVENT_INTELLIGENCE_POSTGRES_SCHEMA_UNVERSIONED';
            throw error;
          }
          await client.query(
            'INSERT INTO ' + this.metadata +
            ' (component, version, adopted_from) VALUES ($1, $2, $3)',
            [
              'store',
              POSTGRES_PERSISTED_SCHEMA_VERSION,
              hasLegacyState ? 'unversioned-explicit' : null,
            ],
          );
        }
        // Semantic identity is versioned separately from the unchanged
        // PostgreSQL physical layout. Old trigger, match, timer and semantic
        // cache records cannot be reinterpreted with the new candidate
        // signature; this decision is guarded by the SAME schema advisory
        // transaction lock, across all scopes and workers.
        const signature = await client.query(
          'SELECT version FROM ' + this.metadata +
          ' WHERE component = $1 FOR UPDATE',
          [PATTERN_V2_SIGNATURE_COMPONENT],
        );
        if (signature.rows.length) {
          if (Number(signature.rows[0].version) !==
              PATTERN_V2_SIGNATURE_CONTRACT_VERSION) {
            throw patternV2SignatureError('unknown persisted PostgreSQL signature version');
          }
        } else {
          const legacy = await client.query(
            'SELECT (' +
            'EXISTS(SELECT 1 FROM ' + this.records +
            " WHERE kind IN ('trigger', 'trigger_state', 'trigger_match', " +
            "'temporal_deadline', 'semantic_cache', 'wake_delivery', 'derived_event') LIMIT 1) OR " +
            'EXISTS(SELECT 1 FROM ' + this.history +
            " WHERE kind IN ('trigger_match_history', 'wake') LIMIT 1)" +
            ') AS present',
          );
          if (legacy.rows[0]?.present === true) {
            throw patternV2SignatureError('unmarked pre-existing PostgreSQL Pattern v2 state');
          }
          await client.query(
            'INSERT INTO ' + this.metadata +
            ' (component, version) VALUES ($1, $2)',
            [PATTERN_V2_SIGNATURE_COMPONENT, PATTERN_V2_SIGNATURE_CONTRACT_VERSION],
          );
        }
        if (freshRecords) {
          await client.query(
            'CREATE INDEX IF NOT EXISTS "' + this.tablePrefix +
            '_records_age_idx" ON ' + this.records +
            ' (scope_id, kind, updated_at, record_key)',
          );
          // Only empty installations may build the orphan-repair indexes
          // synchronously. Existing populated databases need an explicit
          // operator-initiated CONCURRENTLY migration after init().
          await client.query(
            'CREATE INDEX IF NOT EXISTS "' + this.tablePrefix +
            '_records_orphan_status_idx" ON ' + this.records +
            " (scope_id, record_key) WHERE kind = 'trigger_match'" +
            " AND (payload->>'status') = 'matched'",
          );
          await client.query(
            'CREATE INDEX IF NOT EXISTS "' + this.tablePrefix +
            '_records_wake_match_idx" ON ' + this.records +
            " (scope_id, (payload->>'matchId')) WHERE kind = 'wake_delivery'",
          );
        }
      });
      this.initialized = true;
    }
    return this.restoredCounts();
  }

  async assertRetentionIndex(client = this.pool) {
    const indexName = this.tablePrefix + '_records_age_idx';
    // An index name alone does NOT establish a valid retention access path.
    // A same-named index on another table, partial index, hash index, or
    // expression index must fail closed rather than claiming bounded cleanup.
    const current = await client.query(
      'SELECT i.indisvalid AS valid, i.indisready AS ready, ' +
      'i.indpred IS NULL AS not_partial, i.indexprs IS NULL AS no_expr, ' +
      'i.indisunique AS is_unique, am.amname AS method, ' +
      'i.indnkeyatts AS key_count, i.indnatts AS attr_count, ' +
      'tbl.relname AS table_name, ' +
      'ARRAY[pg_get_indexdef(i.indexrelid, 1, true), ' +
      'pg_get_indexdef(i.indexrelid, 2, true), ' +
      'pg_get_indexdef(i.indexrelid, 3, true), ' +
      'pg_get_indexdef(i.indexrelid, 4, true)] AS key_columns ' +
      'FROM pg_class idx JOIN pg_index i ON i.indexrelid = idx.oid ' +
      'JOIN pg_class tbl ON tbl.oid = i.indrelid ' +
      'JOIN pg_am am ON am.oid = idx.relam ' +
      'JOIN pg_namespace n ON n.oid = idx.relnamespace ' +
      'WHERE n.nspname = current_schema() AND idx.relname = $1',
      [indexName],
    );
    const row = current.rows[0];
    if (current.rows.length !== 1 || row.valid !== true ||
        row.ready !== true || row.not_partial !== true ||
        row.no_expr !== true || row.is_unique !== false ||
        row.method !== 'btree' ||
        row.table_name !== this.tablePrefix + '_records' ||
        Number(row.key_count) !== 4 || Number(row.attr_count) !== 4 ||
        JSON.stringify(row.key_columns) !==
          JSON.stringify(['scope_id', 'kind', 'updated_at', 'record_key'])) {
      const error = new Error(
        'Semantic cache TTL requires a valid scoped age index. ' +
        'Run store.migrateRetentionIndex() as an explicit online migration ' +
        'after startup; inspect invalid/conflicting indexes before retry.',
      );
      error.code = 'EVENT_INTELLIGENCE_RETENTION_INDEX_INVALID';
      throw error;
    }
  }

  /**
   * Explicit operator-controlled online migration for populated databases.
   * Never part of init(): parallel startup transactions can deadlock with
   * concurrent index build snapshots. Do not call concurrently per prefix.
   */
  async migrateRetentionIndex() {
    if (!this.initialized) {
      const error = new Error('Initialize and verify the store before migrating');
      error.code = 'EVENT_INTELLIGENCE_RETENTION_MIGRATION_NOT_INITIALIZED';
      throw error;
    }
    // Store a durable, unique operator migration claim in the existing
    // versioned metadata table. PostgreSQL transaction pools (PgBouncer)
    // cannot safely hold session advisory locks across CREATE INDEX
    // CONCURRENTLY, which must run OUTSIDE a transaction.
    const component = 'retention-age-index-migration';
    const claim = randomUUID();
    const inserted = await this.tx(async client => client.query(
      'INSERT INTO ' + this.metadata +
      ' (component, version, adopted_from) VALUES ($1, $2, $3) ' +
      'ON CONFLICT (component) DO NOTHING RETURNING component',
      [component, 1, claim],
    ));
    if (inserted.rows.length !== 1) {
      const error = new Error(
        'Online retention migration is claimed by another operator or ' +
        'has an unresolved interrupted claim. Inspect metadata before retrying.',
      );
      error.code = 'EVENT_INTELLIGENCE_RETENTION_MIGRATION_BUSY';
      throw error;
    }
    let verifiedComplete = false;
    try {
      const existing = await this.pool.query(
        'SELECT 1 FROM pg_class idx JOIN pg_namespace n ' +
        'ON n.oid = idx.relnamespace WHERE n.nspname = current_schema() ' +
        'AND idx.relname = $1',
        [this.tablePrefix + '_records_age_idx'],
      );
      if (!existing.rows.length) {
        // Individual autocommit statement, not a BEGIN transaction:
        // CONCURRENTLY can run without blocking normal trigger writes.
        await this.pool.query(
          'CREATE INDEX CONCURRENTLY IF NOT EXISTS "' + this.tablePrefix +
          '_records_age_idx" ON ' + this.records +
          ' (scope_id, kind, updated_at, record_key)',
        );
      }
      await this.assertRetentionIndex();
      verifiedComplete = true;
      return { ok: true, index: this.tablePrefix + '_records_age_idx' };
    } finally {
      // An error from CREATE INDEX CONCURRENTLY can be ambiguous: after a
      // client timeout or proxy disconnect PostgreSQL may still be building
      // the index. Never release the durable claim on uncertain completion.
      // Operator must inspect pg_stat_progress_create_index and pg_index,
      // then explicitly clear a stale claim after verifying no active DDL.
      if (verifiedComplete) {
        // Compare-and-delete never frees a different operator's claim.
        await this.pool.query(
          'DELETE FROM ' + this.metadata +
          ' WHERE component = $1 AND adopted_from = $2',
          [component, claim],
        );
      }
    }
  }

  async restoredCounts() {
    const [a, b, c] = await Promise.all([
      this.pool.query(
        'SELECT kind, count(*)::bigint AS count FROM ' + this.records +
        ' WHERE scope_id = $1 GROUP BY kind',
        [this.scopeId],
      ),
      this.pool.query(
        'SELECT kind, count(*)::bigint AS count FROM ' + this.history +
        ' WHERE scope_id = $1 GROUP BY kind',
        [this.scopeId],
      ),
      this.pool.query(
        'SELECT count(*)::bigint AS count FROM ' + this.leases +
        " WHERE scope_id = $1 AND lease_kind = 'partition'",
        [this.scopeId],
      ),
    ]);
    const counts = {};
    for (const row of [...a.rows, ...b.rows]) counts[row.kind] = Number(row.count);
    return {
      wakes: counts.wake ?? 0,
      wakeDeliveries: counts.wake_delivery ?? 0,
      triggers: counts.trigger ?? 0,
      triggerStates: counts.trigger_state ?? 0,
      eventSources: counts.event_source ?? 0,
      triggerMatches: counts.trigger_match ?? 0,
      triggerMatchRevisions: counts.trigger_match_history ?? 0,
      mcpOccurrences: counts.mcp_occurrence ?? 0,
      mcpClientStates: counts.mcp_client_state ?? 0,
      temporalDeadlines: counts.temporal_deadline ?? 0,
      derivedEvents: counts.derived_event ?? 0,
      derivedContracts: counts.derived_contract ?? 0,
      semanticDecisionCache: counts.semantic_cache ?? 0,
      partitionLeases: Number(c.rows[0]?.count ?? 0),
      audit: counts.audit ?? 0,
    };
  }

  async tx(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async lock(client, namespace, key) {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [this.tablePrefix + ':' + this.scopeId + ':' + namespace + ':' + key],
    );
  }

  async get(kind, key, client = this.pool, forUpdate = false) {
    const result = await client.query(
      'SELECT payload FROM ' + this.records +
      ' WHERE scope_id = $1 AND kind = $2 AND record_key = $3' +
      (forUpdate ? ' FOR UPDATE' : ''),
      [this.scopeId, kind, String(key)],
    );
    return result.rows[0]?.payload ?? null;
  }

  async list(kind, client = this.pool) {
    const result = await client.query(
      'SELECT payload FROM ' + this.records +
      ' WHERE scope_id = $1 AND kind = $2 ORDER BY record_key',
      [this.scopeId, kind],
    );
    return result.rows.map((row) => row.payload);
  }

  async upsert(kind, key, payload, client = this.pool) {
    await client.query(
      'INSERT INTO ' + this.records +
      ' (scope_id, kind, record_key, payload, updated_at)' +
      ' VALUES ($1, $2, $3, $4::jsonb, clock_timestamp())' +
      ' ON CONFLICT (scope_id, kind, record_key)' +
      ' DO UPDATE SET payload = EXCLUDED.payload, updated_at = clock_timestamp()',
      [this.scopeId, kind, String(key), JSON.stringify(payload)],
    );
    return payload;
  }

  async insert(kind, key, payload, client = this.pool) {
    const result = await client.query(
      'INSERT INTO ' + this.records +
      ' (scope_id, kind, record_key, payload, updated_at)' +
      ' VALUES ($1, $2, $3, $4::jsonb, clock_timestamp())' +
      ' ON CONFLICT (scope_id, kind, record_key) DO NOTHING RETURNING payload',
      [this.scopeId, kind, String(key), JSON.stringify(payload)],
    );
    return result.rows[0]?.payload ?? null;
  }

  async appendHistory(kind, key, payload, client = this.pool) {
    await client.query(
      'INSERT INTO ' + this.history +
      ' (scope_id, kind, record_key, payload) VALUES ($1, $2, $3, $4::jsonb)',
      [this.scopeId, kind, key == null ? null : String(key), JSON.stringify(payload)],
    );
    return payload;
  }

  async historyList(kind, key, client = this.pool) {
    const keyed = key !== undefined;
    const result = await client.query(
      'SELECT payload FROM ' + this.history +
      ' WHERE scope_id = $1 AND kind = $2' +
      (keyed ? ' AND record_key = $3' : '') + ' ORDER BY history_id',
      keyed ? [this.scopeId, kind, String(key)] : [this.scopeId, kind],
    );
    return result.rows.map((row) => row.payload);
  }

  async latestHistory(kind, key) {
    const result = await this.pool.query(
      'SELECT payload FROM ' + this.history +
      ' WHERE scope_id = $1 AND kind = $2 AND record_key = $3' +
      ' ORDER BY history_id DESC LIMIT 1',
      [this.scopeId, kind, String(key)],
    );
    return result.rows[0]?.payload ?? null;
  }

  async nextCounter(name, client) {
    const result = await client.query(
      'INSERT INTO ' + this.counters + ' (scope_id, name, value) VALUES ($1, $2, 1)' +
      ' ON CONFLICT (scope_id, name) DO UPDATE SET value = ' + this.counters + '.value + 1' +
      ' RETURNING value',
      [this.scopeId, String(name)],
    );
    return Number(result.rows[0].value);
  }

  async forScope(scopeIdInput = DEFAULT_EVENT_SCOPE_ID) {
    const scopeId = normalizeEventScopeId(scopeIdInput);
    if (scopeId === this.scopeId) return this;
    if (this.scopeStores.has(scopeId)) return this.scopeStores.get(scopeId);
    const scoped = new PostgresEventStore({
      pool: this.pool,
      scopeId,
      tablePrefix: this.tablePrefix,
      ownsPool: false,
      adoptUnversionedSchema: this.adoptUnversionedSchema,
    });
    scoped.initialized = this.initialized;
    if (!scoped.initialized) await scoped.init();
    this.scopeStores.set(scopeId, scoped);
    return scoped;
  }

  async listScopeIds() {
    const result = await this.pool.query(
      'SELECT DISTINCT scope_id FROM (' +
      'SELECT scope_id FROM ' + this.records +
      ' UNION ALL SELECT scope_id FROM ' + this.history +
      ' UNION ALL SELECT scope_id FROM ' + this.leases +
      ' UNION ALL SELECT scope_id FROM ' + this.counters +
      ') AS scopes ORDER BY scope_id',
    );
    return [...new Set([
      DEFAULT_EVENT_SCOPE_ID,
      this.scopeId,
      ...result.rows.map((row) => String(row.scope_id)),
    ])].sort();
  }

  async appendWake(record) {
    await this.appendHistory('wake', record.wakeId, record);
    return record;
  }

  latestWake(wakeId) {
    return this.latestHistory('wake', wakeId);
  }

  // Idempotent, scope-local materialization after a durable delivery receipt.
  // The same advisory transaction lock is shared by independent PG pools,
  // so concurrent recovery workers cannot append duplicate delivered rows.
  // Existing schema/history remains unchanged; never delete queued evidence.
  async appendDeliveredWakeIfMissing(record) {
    if (!record?.wakeId || record.status !== 'delivered') {
      throw new Error('Delivered wake materialization requires delivered WakeRecord');
    }
    return this.tx(async (client) => {
      await this.lock(client, 'wake-delivered-history', record.wakeId);
      const existing = await client.query(
        'SELECT payload FROM ' + this.history +
          ' WHERE scope_id=$1 AND kind=$2 AND record_key=$3' +
          " AND payload->>'status'='delivered'" +
          ' ORDER BY history_id DESC LIMIT 1',
        [this.scopeId, 'wake', String(record.wakeId)],
      );
      if (existing.rows.length) {
        return { wake: existing.rows[0].payload, appended: false };
      }
      await this.appendHistory('wake', record.wakeId, record, client);
      return { wake: record, appended: true };
    });
  }

  getWakeDelivery(wakeId) {
    return this.get('wake_delivery', wakeId);
  }

  /**
   * Bounded, scope-local scan of durable Pattern matches which may have
   * survived a process crash before ANY wake_delivery was inserted.
   * Match selection is anchored by the existing (scope,kind,key) PK.
   * The coordinator remains the authority for exact-target wake id,
   * transactional claim, receipt and dedup. Never delete an orphan here.
   */
  async assertOrphanRecoveryIndexes() {
    const suffixes = ['_records_orphan_status_idx', '_records_wake_match_idx'];
    const result = await this.pool.query(
      'SELECT idx.relname AS name, tbl.relname AS table_name, ' +
      'i.indisvalid AS valid, i.indisready AS ready, ' +
      'am.amname AS method, i.indnkeyatts AS keys, ' +
      'pg_get_indexdef(i.indexrelid, 1, true) AS key1, ' +
      'pg_get_indexdef(i.indexrelid, 2, true) AS key2, ' +
      'pg_get_expr(i.indpred, i.indrelid) AS predicate ' +
      'FROM pg_class idx JOIN pg_index i ON i.indexrelid=idx.oid ' +
      'JOIN pg_class tbl ON tbl.oid=i.indrelid ' +
      'JOIN pg_am am ON am.oid=idx.relam ' +
      'JOIN pg_namespace ns ON ns.oid=idx.relnamespace ' +
      'WHERE ns.nspname=current_schema() AND idx.relname=ANY($1)',
      [suffixes.map(suffix => this.tablePrefix + suffix)],
    );
    const present = new Map(result.rows.map(row => [row.name, row]));
    // Normalize only PostgreSQL's cosmetic casts, whitespace and brackets.
    // Compare ALL predicate atoms, not just substrings: an extra restrictive
    // condition makes a partial index unusable for the exact recovery query.
    const normalize = value => String(value ?? '')
      .replace(/::text/g, '').replace(/\s+/g, '').replace(/[()]/g, '');
    const atoms = value => normalize(value).split('AND').sort().join('AND');
    const schemas = [
      { suffix: suffixes[0], key2: 'record_key',
        predicate: "kind='trigger_match'ANDpayload->>'status'='matched'" },
      { suffix: suffixes[1], key2: "payload->>'matchId'",
        predicate: "kind='wake_delivery'" },
    ];
    for (const expected of schemas) {
      const row = present.get(this.tablePrefix + expected.suffix);
      if (!row || row.valid !== true || row.ready !== true ||
          row.method !== 'btree' || row.table_name !== this.tablePrefix + '_records' ||
          Number(row.keys) !== 2 || normalize(row.key1) !== 'scope_id' ||
          normalize(row.key2) !== normalize(expected.key2) ||
          atoms(row.predicate) !== atoms(expected.predicate)) {
        const error = new Error(
          'PG orphan reconciliation needs both verified scoped expression indexes; ' +
          'run store.migrateOrphanRecoveryIndexes() explicitly after store.init(). ' +
          'Do not repeatedly scan historical matches without indexes.',
        );
        error.code = 'EVENT_INTELLIGENCE_ORPHAN_RECOVERY_INDEX_REQUIRED';
        throw error;
      }
    }
  }

  /**
   * Explicit, nonblocking online operator migration for populated PG stores.
   * No CREATE INDEX on production startup; a durable claim prevents two
   * operators starting concurrent index creation on the same prefix.
   */
  async migrateOrphanRecoveryIndexes() {
    if (!this.initialized) {
      const error = new Error('Initialize store before orphan index migration');
      error.code = 'EVENT_INTELLIGENCE_ORPHAN_MIGRATION_NOT_INITIALIZED';
      throw error;
    }
    const component = 'orphan-recovery-index-migration';
    const claim = randomUUID();
    const inserted = await this.tx(client => client.query(
      'INSERT INTO ' + this.metadata +
      ' (component, version, adopted_from) VALUES ($1, 1, $2)' +
      ' ON CONFLICT (component) DO NOTHING RETURNING component',
      [component, claim],
    ));
    if (inserted.rows.length !== 1) {
      const error = new Error('Orphan index migration has an outstanding operator claim');
      error.code = 'EVENT_INTELLIGENCE_ORPHAN_MIGRATION_BUSY';
      throw error;
    }
    let verified = false;
    try {
      const statements = [
        ['_records_orphan_status_idx',
          " (scope_id, record_key) WHERE kind = 'trigger_match'" +
          " AND (payload->>'status') = 'matched'"],
        ['_records_wake_match_idx',
          " (scope_id, (payload->>'matchId')) WHERE kind = 'wake_delivery'"],
      ];
      for (const [suffix, ddl] of statements) {
        const name = this.tablePrefix + suffix;
        const existing = await this.pool.query(
          'SELECT 1 FROM pg_class idx JOIN pg_namespace ns' +
          ' ON ns.oid=idx.relnamespace' +
          ' WHERE ns.nspname=current_schema() AND idx.relname=$1',
          [name],
        );
        if (!existing.rows.length) {
          await this.pool.query(
            'CREATE INDEX CONCURRENTLY IF NOT EXISTS "' + name +
            '" ON ' + this.records + ddl,
          );
        }
      }
      await this.assertOrphanRecoveryIndexes();
      verified = true;
      return { ok: true, indexes: statements.map(([suffix]) => this.tablePrefix + suffix) };
    } finally {
      // An interrupted CONCURRENTLY build may still be running (or have
      // left an invalid index). Leave the claim until operator diagnosis.
      if (verified) await this.pool.query(
        'DELETE FROM ' + this.metadata +
        ' WHERE component=$1 AND adopted_from=$2',
        [component, claim],
      );
    }
  }

  async listOrphanedMatchedWakeCandidates({
    afterMatchId = '',
    limit = 32,
  } = {}) {
    if (typeof afterMatchId !== 'string' ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('orphan match scan requires a string cursor and limit 1..100');
    }
    await this.assertOrphanRecoveryIndexes();
    const result = await this.pool.query(
      'SELECT m.payload FROM ' + this.records + ' AS m' +
      " WHERE m.scope_id=$1 AND m.kind='trigger_match' AND m.record_key>$2" +
      " AND (m.payload->>'status')='matched'" +
      ' AND NOT EXISTS (' +
      ' SELECT 1 FROM ' + this.records + ' AS d' +
      " WHERE d.scope_id=m.scope_id AND d.kind='wake_delivery'" +
      " AND (d.payload->>'matchId')=m.record_key" +
      ' ) ORDER BY m.record_key LIMIT $3',
      [this.scopeId, afterMatchId, limit],
    );
    return result.rows.map(row => parseTriggerMatchRecord(row.payload));
  }

  async listDueWakeDeliveries(nowIso = new Date().toISOString()) {
    const now = Date.parse(nowIso);
    const out = [];
    for (const record of await this.list('wake_delivery')) {
      if (
        (record.status === 'pending' || record.status === 'retry_pending') &&
        Date.parse(record.nextAttemptAt) <= now
      ) {
        out.push(record);
      } else if (
        record.status === 'claimed' && record.leaseUntil &&
        Date.parse(record.leaseUntil) <= now
      ) {
        out.push(record);
      } else if (record.status === 'delivered') {
        const wake = await this.latestWake(record.wakeId);
        const match = await this.get('trigger_match', record.matchId);
        if (wake?.status !== 'delivered' || match?.status !== 'fired') out.push(record);
      }
    }
    return out.sort((a, b) =>
      Date.parse(a.nextAttemptAt) - Date.parse(b.nextAttemptAt) ||
      a.wakeId.localeCompare(b.wakeId)
    );
  }

  async ensureWakeDelivery(input) {
    const wakeId = String(input.wakeId || '');
    const matchId = String(input.matchId || '');
    const runtime = String(input.runtime || '');
    if (!wakeId || !matchId || !runtime) {
      throw new Error('Wake delivery requires wakeId, matchId and runtime');
    }
    const now = String(input.now ?? new Date().toISOString());
    const record = {
      wakeId,
      matchId,
      triggerId: String(input.triggerId || ''),
      triggerVersion: String(input.triggerVersion || '1'),
      runtime,
      status: 'pending',
      attemptCount: 0,
      nextAttemptAt: now,
      leaseOwner: null,
      leaseUntil: null,
      runtimeReceiptId: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    return await this.insert('wake_delivery', wakeId, record) ??
      this.getWakeDelivery(wakeId);
  }

  async claimWakeDelivery(wakeIdInput, {
    workerId,
    now = new Date().toISOString(),
    leaseMs = 30000,
  } = {}) {
    const wakeId = String(wakeIdInput || '');
    const owner = String(workerId || '');
    if (!wakeId || !owner) {
      throw new Error('Wake delivery claim requires wakeId and workerId');
    }
    return this.tx(async (client) => {
      const current = await this.get('wake_delivery', wakeId, client, true);
      if (!current || ['delivered', 'dead_letter'].includes(current.status)) return null;
      const nowMs = Date.parse(now);
      const ready =
        ((current.status === 'pending' || current.status === 'retry_pending') &&
          Date.parse(current.nextAttemptAt) <= nowMs) ||
        (current.status === 'claimed' && current.leaseUntil &&
          Date.parse(current.leaseUntil) <= nowMs);
      if (!ready) return null;
      const record = {
        ...current,
        status: 'claimed',
        attemptCount: Number(current.attemptCount || 0) + 1,
        leaseOwner: owner,
        leaseUntil: new Date(
          nowMs + Math.max(1000, Number(leaseMs) || 30000),
        ).toISOString(),
        updatedAt: String(now),
      };
      await this.upsert('wake_delivery', wakeId, record, client);
      return record;
    });
  }

  async completeWakeDelivery(wakeIdInput, {
    workerId,
    attemptCount,
    runtimeReceiptId,
    now = new Date().toISOString(),
  } = {}) {
    const wakeId = String(wakeIdInput || '');
    return this.tx(async (client) => {
      const current = await this.get('wake_delivery', wakeId, client, true);
      if (!current) return null;
      assertWakeClaimGeneration(current, {
        workerId, attemptCount, wakeId, allowDelivered: true,
      });
      if (current.status === 'delivered') return current;
      const record = {
        ...current,
        status: 'delivered',
        runtimeReceiptId: String(runtimeReceiptId || ''),
        leaseOwner: null,
        leaseUntil: null,
        nextAttemptAt: String(now),
        lastError: null,
        updatedAt: String(now),
      };
      await this.upsert('wake_delivery', wakeId, record, client);
      return record;
    });
  }

  async failWakeDelivery(wakeIdInput, {
    workerId,
    attemptCount,
    error,
    now = new Date().toISOString(),
    maxAttempts = 5,
    nextAttemptAt = now,
  } = {}) {
    const wakeId = String(wakeIdInput || '');
    return this.tx(async (client) => {
      const current = await this.get('wake_delivery', wakeId, client, true);
      if (!current) return null;
      assertWakeClaimGeneration(current, { workerId, attemptCount, wakeId });
      const terminal =
        Number(current.attemptCount || 0) >= Math.max(1, Number(maxAttempts) || 5);
      const record = {
        ...current,
        status: terminal ? 'dead_letter' : 'retry_pending',
        leaseOwner: null,
        leaseUntil: null,
        nextAttemptAt: terminal ? String(now) : String(nextAttemptAt),
        lastError: error instanceof Error
          ? error.message
          : String(error || 'wake delivery failed'),
        updatedAt: String(now),
      };
      await this.upsert('wake_delivery', wakeId, record, client);
      return record;
    });
  }

  async putTrigger(input) {
    const parsed = parseCompositeTriggerDefinition(input);
    const definition = {
      ...parsed,
      clauses: parsed.clauses.map((clause) => ({
        ...clause,
        arguments: safeMcpSourceArguments(clause.arguments),
      })),
    };
    const key = definition.triggerId + '@' + definition.version;
    if (!await this.insert('trigger', key, definition)) {
      const error = new Error('Trigger ' + key + ' already exists');
      error.code = 'TRIGGER_ALREADY_EXISTS';
      throw error;
    }
    return definition;
  }

  /** Current, scope-local, indexed lookup. Never cached across revocation or restart. */
  async getTrigger(triggerId, version) {
    const raw = await this.get('trigger', String(triggerId) + '@' + String(version));
    return raw ? parseCompositeTriggerDefinition(raw) : null;
  }

  async listTriggers() {
    return (await this.list('trigger')).map(parseCompositeTriggerDefinition);
  }

  // Read the current durable scope on EVERY ingest. The query deliberately
  // returns a *superset* of matching source candidates, never a snapshot
  // cache that could miss trigger registration, pause, owner/source updates,
  // or revoke. Exact arguments/contract/predicate checks remain in the
  // canonical clauseMatches() path, after current lifecycle authorization.
  //
  // Lifecycle transitions on unrelated events must never be skipped:
  // expiry, lease expiry, oneShot and maxFirings definitions are included
  // even if NONE of their clauses has this source/event name. Ordering is
  // the same record_key order as listTriggers(). This optimization does
  // not alter PostgreSQL schema or create an index on existing deployments.
  async listTriggerCandidatesForEvent({ name, serverId, data } = {}) {
    if (typeof name !== 'string' || !name) {
      throw new TypeError('candidate event name must be nonempty');
    }
    // Only enable this conservative pushdown for flat JSON objects whose
    // numeric values are safe integers. JS eq on an unsafe number/fraction
    // cannot be assumed equivalent to PostgreSQL JSONB numeric comparison
    // after JSON serialization, so complex/untrusted inputs fail OPEN and
    // run the canonical clauseMatches() evaluation in Node.
    // PostgreSQL JSONB disallows U+0000 and rejects malformed surrogate
    // escapes. For this optional fast path, conservatively refuse *all*
    // surrogate code units (even valid pairs) rather than risk a failed
    // source query; canonical Node matching still receives the event.
    const pgJsonbSafeText = (value) => {
      for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code === 0 || (code >= 0xd800 && code <= 0xdfff)) return false;
      }
      return true;
    };
    const flat = data !== null && data !== undefined &&
      typeof data === 'object' && !Array.isArray(data) &&
      Object.entries(data).every(([key, value]) =>
        pgJsonbSafeText(key) && (
          value === null ||
          (typeof value === 'string' && pgJsonbSafeText(value)) ||
          typeof value === 'boolean' ||
          (typeof value === 'number' && Number.isSafeInteger(value))
        )
      );
    const sourceData = flat ? JSON.stringify(data) : null;
    const hasSafeEqPushdown = typeof sourceData === 'string';
    // Evaluate only a single top-level numeric equality predicate.
    // Anything more complex (additional predicates, nested paths, regex,
    // lifecycle work, multi-clause alternatives) remains in the superset.
    // The SQL predicate is attached to EACH source-matching clause so an
    // unrelated clause cannot accidentally hide a valid alternative.
    const numericEqSuperset = hasSafeEqPushdown
      ? ' AND (' +
        " jsonb_typeof(clause->'where') <> 'array'" +
        " OR jsonb_array_length(clause->'where') <> 1" +
        " OR clause->'where'->0->>'op' IS DISTINCT FROM 'eq'" +
        // A fraction or a non-safe integer in a definition must also
        // fail OPEN; the JavaScript matcher remains authoritative.
        " OR CASE WHEN jsonb_typeof(clause->'where'->0->'value') = 'number'" +
        " THEN (" +
        " ((clause->'where'->0->>'value')::numeric <>" +
        " trunc((clause->'where'->0->>'value')::numeric))" +
        " OR abs((clause->'where'->0->>'value')::numeric) > 9007199254740991" +
        " ) ELSE TRUE END" +
        " OR strpos(clause->'where'->0->>'path', '.') > 0" +
        ' OR (' +
        " ($6::jsonb ? (clause->'where'->0->>'path'))" +
        " AND ($6::jsonb -> (clause->'where'->0->>'path')) =" +
        " clause->'where'->0->'value'" +
        ' )' +
        ')'
      : '';
    const result = await this.pool.query(
      'SELECT payload FROM ' + this.records +
        ' WHERE scope_id = $1 AND kind = $2 AND (' +
        " (payload->'lifecycle'->>'expiresAt' IS NOT NULL)" +
        " OR (payload->'lifecycle'->>'leaseUntil' IS NOT NULL)" +
        " OR (payload->'lifecycle'->>'oneShot' = 'true')" +
        " OR (payload->'lifecycle' ? 'maxFirings')" +
        ' OR (' +
        " (payload->'clauses' @> $3::jsonb)" +
        ' AND EXISTS (' +
        " SELECT 1 FROM jsonb_array_elements(payload->'clauses') AS clause" +
        " WHERE clause->>'event' = $4" +
        " AND (NOT clause ? 'serverId'" +
        " OR COALESCE(clause->>'serverId', '') = ''" +
        " OR clause->>'serverId' = $5)" +
        numericEqSuperset +
        ' )' +
        ' )' +
        ') ORDER BY record_key',
      [
        this.scopeId, 'trigger', JSON.stringify([{ event: name }]),
        name, serverId ?? null,
        ...(hasSafeEqPushdown ? [sourceData] : []),
      ],
    );
    return result.rows.map((row) => parseCompositeTriggerDefinition(row.payload));
  }

  async getTriggerState(triggerId, version) {
    return await this.get('trigger_state', triggerId + '@' + version) ??
      defaultTriggerState(triggerId, version);
  }

  async setTriggerState(triggerId, version, status, actor = null, metadata = {}) {
    if (!['active', 'paused', 'completed', 'expired', 'deleted'].includes(status)) {
      throw new Error('Invalid trigger lifecycle status: ' + status);
    }
    const key = String(triggerId) + '@' + String(version);
    return this.tx(async (client) => {
      // The SAME async delivery already holds the session advisory lock
      // until completeWakeDelivery + markFired finish. Do not attempt to
      // re-acquire that lock on another connection for its own system
      // lifecycle finalization (which would deadlock). All independent
      // mutations still acquire the ordinary transactional lock.
      const context = dispatchContext.getStore();
      const lifecycleReentrant =
        context?.store === this && context.key === key &&
        actor?.principal_id === 'event-intelligence:lifecycle';
      if (!lifecycleReentrant) await this.lock(client, 'trigger-state', key);
      const previous = await this.get('trigger_state', key, client) ??
        defaultTriggerState(triggerId, version);
      // A wake callback may finish just before a user pause/delete, while
      // its markFired/lifecycle continuation is still pending. That system
      // continuation must NEVER resurrect an already-revoked trigger.
      // Check under the same state transaction/advisory lock as user edits.
      if (actor?.principal_id === 'event-intelligence:lifecycle' &&
          previous.status !== 'active') return previous;
      const next = {
        triggerId: String(triggerId),
        version: String(version),
        status,
        updatedAt: new Date().toISOString(),
        actor,
        owner: metadata.owner ?? previous.owner ?? null,
        connectionIds: Array.isArray(metadata.connectionIds)
          ? metadata.connectionIds.map(String)
          : previous.connectionIds ?? [],
        fireCount: Number.isInteger(metadata.fireCount)
          ? metadata.fireCount
          : previous.fireCount ?? 0,
        lastFiredAt: metadata.lastFiredAt !== undefined
          ? metadata.lastFiredAt
          : previous.lastFiredAt ?? null,
        revision: Number(previous.revision || 0) + 1,
      };
      await this.upsert('trigger_state', key, next, client);
      return next;
    });
  }

  /**
   * Fence the ACTUAL external host callback against concurrent pause/delete
   * commits. This session advisory lock has the SAME key as the transaction
   * lock in setTriggerState(). Revocation cannot commit until the callback
   * returns; a post-revocation attempt re-reads status under the lock.
   * Requires a session-preserving PostgreSQL connection (not transaction
   * pooling PgBouncer) and >=2 pool slots for callbacks that use the store.
   */
  async withTriggerDispatchFence(triggerId, version, at, operation) {
    if (typeof operation !== 'function') throw new TypeError('dispatch callback required');
    const key = String(triggerId) + '@' + String(version);
    const maxPool = Number(this.pool.options?.max ?? 10);
    if (!Number.isSafeInteger(maxPool) || maxPool < 3) {
      const error = new Error('Fenced PG dispatch requires >=3 pool connections');
      error.code = 'EVENT_INTELLIGENCE_DISPATCH_POOL_TOO_SMALL';
      throw error;
    }
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) throw new TypeError('dispatch time must be valid ISO');
    const lockKey = this.tablePrefix + ':' + this.scopeId + ':trigger-state:' + key;

    return withPoolFenceCapacity(this.pool, maxPool - 2, async () => {
      const client = await this.pool.connect();
      let locked = false;
      try {
        // Never let another callback sit idle while HOLDING a pool client
        // waiting for this advisory lock. A loser retries via the normal
        // durable wake delivery schedule.
        const attempt = await client.query(
          'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
          [lockKey],
        );
        if (attempt.rows[0]?.acquired !== true) {
          return { authorized: false, reason: 'trigger_dispatch_busy' };
        }
        locked = true;
        const raw = await this.get('trigger', key, client);
        const state = await this.get('trigger_state', key, client) ??
          defaultTriggerState(triggerId, version);
        const definition = raw ? parseCompositeTriggerDefinition(raw) : null;
        const lifecycle = definition?.lifecycle ?? {};
        const expiresAt = lifecycle.expiresAt
          ? Date.parse(lifecycle.expiresAt) : Number.POSITIVE_INFINITY;
        const leaseUntil = lifecycle.leaseUntil
          ? Date.parse(lifecycle.leaseUntil) : Number.POSITIVE_INFINITY;
        const count = state.fireCount ?? 0;
        if (!definition?.target || state.status !== 'active' ||
            atMs > Math.min(expiresAt, leaseUntil) ||
            (lifecycle.oneShot === true && count >= 1) ||
            (lifecycle.maxFirings !== undefined && count >= lifecycle.maxFirings)) {
          return { authorized: false, reason: 'trigger_not_active_at_dispatch' };
        }
        // The callback includes ALL durable receipt/lifecycle finalization,
        // not just the external HTTP/host side effect. One-shot and max-fire
        // counters are therefore committed BEFORE the next match can pass.
        const value = await dispatchContext.run({ store: this, key }, operation);
        return { authorized: true, value };
      } finally {
        if (locked) {
          try {
            await client.query(
              'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
              [lockKey],
            );
            client.release();
          } catch (error) {
            // Do not return an uncertain SESSION-locked connection to pool.
            client.release(error);
            throw error;
          }
        } else {
          client.release();
        }
      }
    });
  }

  listTriggerStates() {
    return this.list('trigger_state');
  }

  async putEventSource(input) {
    const source = {
      sourceId: String(input.sourceId),
      connectionId: String(input.connectionId),
      serverId: String(input.serverId || input.connectionId),
      eventName: String(input.eventName),
      ...(input.description ? { description: String(input.description) } : {}),
      delivery: Array.isArray(input.delivery) && input.delivery.length
        ? input.delivery.map(String)
        : ['webhook'],
      ...(input.inputSchema && typeof input.inputSchema === 'object'
        ? { inputSchema: input.inputSchema }
        : {}),
      ...(input.payloadSchema && typeof input.payloadSchema === 'object'
        ? { payloadSchema: input.payloadSchema }
        : {}),
      enabled: input.enabled !== false,
      experimental: input.experimental !== false,
      ...(input.metadata && typeof input.metadata === 'object'
        ? { metadata: input.metadata }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    if (!source.sourceId || !source.connectionId || !source.eventName) {
      throw new Error('event source requires sourceId, connectionId, eventName');
    }
    return this.upsert('event_source', source.sourceId, source);
  }

  async listEventSources({ connectionIds, enabledOnly = false } = {}) {
    const ids = Array.isArray(connectionIds) && connectionIds.length
      ? new Set(connectionIds.map(String))
      : null;
    return (await this.list('event_source'))
      .filter((source) => !ids || ids.has(source.connectionId))
      .filter((source) => !enabledOnly || source.enabled !== false);
  }

  async getMcpGapStateAndSnapshot() {
    // One SQL SELECT yields a coherent read-committed view of this scope.
    const states=await this.list('mcp_client_state');
    return { states, snapshot:mcpGapSnapshot(states) };
  }

  async appendTriggerMatchIfMcpGapUnchanged(input, expectedSnapshot, expectedBuffer) {
    const record=parseTriggerMatchRecord(input);
    return this.tx(async(client)=>{
      // Acquire completeness fence first; all buffer writes hold their
      // trigger-match lock. Both checks and the final match insert share
      // this transaction so neither a gap nor a replay can interleave.
      await this.lock(client,'mcp-gap-fence','scope');
      const states=await this.list('mcp_client_state',client);
      if(mcpGapSnapshot(states)!==expectedSnapshot) return false;
      await this.lock(client,'trigger-match',expectedBuffer.matchId);
      const current=await this.get('trigger_match',expectedBuffer.matchId,client);
      if(!current ||
          JSON.stringify(parseTriggerMatchRecord(current)) !==
          JSON.stringify(parseTriggerMatchRecord(expectedBuffer))) {
        return false;
      }
      await this.lock(client,'trigger-match',record.matchId);
      await this.appendHistory('trigger_match_history',
        record.matchId,record,client);
      await this.upsert('trigger_match',record.matchId,record,client);
      return true;
    });
  }

  async appendTriggerMatch(input) {
    const record = parseTriggerMatchRecord(input);
    return this.tx(async (client) => {
      await this.lock(client, 'trigger-match', record.matchId);
      await this.appendHistory(
        'trigger_match_history',
        record.matchId,
        record,
        client,
      );
      await this.upsert('trigger_match', record.matchId, record, client);
      return record;
    });
  }

  async compareAndAppendTriggerMatch(
    input,
    { expectedStatuses = [] } = {},
  ) {
    const record = parseTriggerMatchRecord(input);
    const expected = new Set(expectedStatuses.map(String));
    return this.tx(async (client) => {
      await this.lock(client, 'trigger-match', record.matchId);
      const current = await this.get(
        'trigger_match',
        record.matchId,
        client,
      );
      if (!current || !expected.has(current.status)) {
        return {
          applied: false,
          record: current ? parseTriggerMatchRecord(current) : null,
        };
      }
      await this.appendHistory(
        'trigger_match_history',
        record.matchId,
        record,
        client,
      );
      await this.upsert('trigger_match', record.matchId, record, client);
      return { applied: true, record };
    });
  }

  async listTriggerMatches(triggerId) {
    return (await this.list('trigger_match'))
      .map(parseTriggerMatchRecord)
      .filter((record) => !triggerId || record.triggerId === triggerId);
  }

  async listTriggerMatchHistory(matchId) {
    return (await this.historyList('trigger_match_history', matchId))
      .map(parseTriggerMatchRecord);
  }

  /**
   * Scope-constrained, index-backed bounded history. Request limit + 1 so
   * callers can distinguish truncated history without loading all revisions.
   * Returned records preserve oldest-to-newest order within the window.
   */
  async getRecentTriggerMatchHistory(matchId, { limit = 100 } = {}) {
    const safeLimit = validateHistoryWindowLimit(limit);
    const result = await this.pool.query(
      'SELECT payload FROM ' + this.history +
        ' WHERE scope_id = $1 AND kind = $2 AND record_key = $3' +
        ' ORDER BY history_id DESC LIMIT $4',
      [this.scopeId, 'trigger_match_history', String(matchId), safeLimit + 1],
    );
    const rows = result.rows;
    return {
      records: rows.slice(0, safeLimit).map((row) =>
        parseTriggerMatchRecord(row.payload)
      ).reverse(),
      hasMore: rows.length > safeLimit,
      limit: safeLimit,
    };
  }

  /**
   * Explicit, per-match and scope-local operator retention.
   * Never remove a distinct transition, first/last witness of a run,
   * current trigger_match, MCP occurrence/dedup, wake, receipt or audit row.
   * No implicit TTL job: only exact adjacent duplicate *snapshots* of a
   * durably fired match may be pruned, and only before a past cutoff.
   */
  async compactTerminalMatchDuplicateHistory({
    matchId,
    before,
    maxRows = 100,
    dryRun = true,
  } = {}) {
    if (typeof matchId !== 'string' || !matchId.trim() ||
        !z.iso.datetime({ offset: true }).safeParse(before).success ||
        Date.parse(before) > Date.now() ||
        !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 1000 ||
        typeof dryRun !== 'boolean') {
      const error = new TypeError(
        'Match history compaction needs matchId, past offset-aware ISO cutoff, ' +
        'maxRows 1..1000 and boolean dryRun',
      );
      error.code = 'EVENT_INTELLIGENCE_MATCH_HISTORY_RETENTION_INVALID';
      throw error;
    }
    return this.tx(async (client) => {
      // The same advisory lock serializes appendTriggerMatch and markFired
      // across separate PostgreSQL pools. No writer can interleave between
      // candidate selection and deletion. Lock current row as well.
      await this.lock(client, 'trigger-match', matchId);
      const current = await this.get('trigger_match', matchId, client, true);
      if (!current || current.status !== 'fired') {
        return {
          ok: true, strategy: 'terminal-match-adjacent-duplicate-retention',
          scopeId: this.scopeId, matchId, dryRun, eligible: 0,
          deleted: 0, capped: false, skipped: 'not_fired',
        };
      }
      // LAG+LEAD must examine *all* revisions of this ONE match before
      // applying cutoff and maxRows. Filtering first could erase a boundary
      // witness of an older-vs-newer transition. The key index confines the
      // scan to the selected scope, kind and matchId.
      const candidatesSql =
        'WITH ordered AS (' +
        ' SELECT history_id, created_at, payload,' +
        ' LAG(payload) OVER (ORDER BY history_id) AS previous_payload,' +
        ' LEAD(payload) OVER (ORDER BY history_id) AS next_payload' +
        ' FROM ' + this.history +
        ' WHERE scope_id=$1 AND kind=$2 AND record_key=$3' +
        '), candidates AS (' +
        ' SELECT history_id FROM ordered' +
        ' WHERE created_at < $4::timestamptz' +
        ' AND payload = previous_payload AND payload = next_payload' +
        ' ORDER BY history_id LIMIT $5' +
        ') ';
      const args = [
        this.scopeId, 'trigger_match_history', matchId, before, maxRows,
      ];
      // Deleting only interior exact duplicates preserves the first and
      // last witness of every consecutive identical run (even when the
      // same payload reappears after a different revision).
      const result = dryRun
        ? await client.query(
            candidatesSql + 'SELECT history_id FROM candidates', args,
          )
        : await client.query(
            candidatesSql +
            'DELETE FROM ' + this.history + ' AS h USING candidates AS c' +
            ' WHERE h.history_id=c.history_id AND h.scope_id=$1' +
            ' AND h.kind=$2 AND h.record_key=$3 RETURNING h.history_id',
            args,
          );
      const count = result.rows.length;
      return {
        ok: true, strategy: 'terminal-match-adjacent-duplicate-retention',
        scopeId: this.scopeId, matchId, dryRun,
        eligible: count, deleted: dryRun ? 0 : count,
        capped: count === maxRows,
      };
    });
  }

  async appendMcpOccurrence(serverId, eventInput, subscriptionIdInput = null) {
    const event = McpEventOccurrenceSchema.parse(eventInput);
    const subscriptionId = subscriptionIdInput == null
      ? null
      : String(subscriptionIdInput);
    const key =
      String(serverId) + ':' + (subscriptionId ?? '') + ':' + event.eventId;
    return this.tx(async (client) => {
      await this.lock(client, 'mcp-occurrence', key);
      const existing = await this.get('mcp_occurrence_key', key, client);
      if (existing) {
        return {
          accepted: false,
          sequence: existing.sequence,
          event: existing.event,
        };
      }
      const sequence = await this.nextCounter('mcp_occurrence', client);
      const record = {
        sequence,
        serverId: String(serverId),
        subscriptionId,
        event,
      };
      await this.upsert('mcp_occurrence_key', key, record, client);
      await this.appendHistory('mcp_occurrence', key, record, client);
      return { accepted: true, sequence, event };
    });
  }

  async latestMcpEventSequence() {
    const result = await this.pool.query(
      'SELECT value FROM ' + this.counters +
      " WHERE scope_id = $1 AND name = 'mcp_occurrence'",
      [this.scopeId],
    );
    return Number(result.rows[0]?.value ?? 0);
  }

  async listMcpOccurrencesAfter(sequence) {
    return (await this.historyList('mcp_occurrence'))
      .filter((record) => Number(record.sequence) > Number(sequence))
      .sort((a, b) => Number(a.sequence) - Number(b.sequence))
      .map((record) => ({
        sequence: Number(record.sequence),
        serverId: String(record.serverId),
        subscriptionId: record.subscriptionId ?? null,
        event: { ...record.event, data: { ...record.event.data } },
      }));
  }

  getMcpClientState(connectionId, eventName, args = {}) {
    return this.get(
      'mcp_client_state',
      mcpStateKey(connectionId, eventName, args),
    );
  }

  async listMcpClientStates(connectionId) {
    return (await this.list('mcp_client_state'))
      .filter((state) =>
        !connectionId || state.connectionId === String(connectionId)
      );
  }

  async putMcpClientState(input) {
    const connectionId = String(input.connectionId || '');
    const eventName = String(input.eventName || '');
    if (!connectionId || !eventName) {
      throw new Error('MCP client state requires connectionId and eventName');
    }
    const args = safeMcpSourceArguments(input.arguments);
    const key = mcpStateKey(connectionId, eventName, args);
    return this.tx(async (client) => {
      // Preserve lock ordering: scope fence, then individual source lock.
      await this.lock(client, 'mcp-gap-fence', 'scope');
      await this.lock(client, 'mcp-client-state', key);
      const previous = await this.get('mcp_client_state', key, client);
      const priorRevision = previous?.completenessRevision ?? 0;
      if (!Number.isSafeInteger(priorRevision) ||
          priorRevision < 0 ||
          priorRevision === Number.MAX_SAFE_INTEGER) {
        throw new Error('Invalid or exhausted MCP completeness revision');
      }
      if (input.gapReconciled === true) {
        if (typeof input.reconciliationEvidenceId !== 'string' ||
            !input.reconciliationEvidenceId.trim()) {
          throw new Error('Gap reconciliation requires host evidence ID');
        }
        if (!Number.isSafeInteger(input.expectedCompletenessRevision) ||
            input.expectedCompletenessRevision < 0) {
          throw new Error('Gap reconciliation requires expected completeness revision');
        }
        // The source lock and scope fence guarantee inter-worker CAS.
        if (input.expectedCompletenessRevision !== priorRevision) {
          const error = new Error('Gap reconciliation completeness revision conflict');
          error.code = 'MCP_EVENTS_GAP_REVISION_CONFLICT';
          throw error;
        }
        if (previous?.gapUnresolved !== true &&
            previous?.truncated !== true) {
          throw new Error('Gap reconciliation requires an unresolved gap');
        }
      }
      const state = {
        connectionId,
        serverId: String(input.serverId || previous?.serverId || connectionId),
        eventName,
        arguments: args,
        subscriptionId: input.subscriptionId
          ? String(input.subscriptionId)
          : previous?.subscriptionId ?? null,
        deliveryMode: String(
          input.deliveryMode || previous?.deliveryMode || 'poll',
        ),
        cursor: input.cursor == null ? null : String(input.cursor),
        updatedAt: new Date().toISOString(),
        completenessRevision: priorRevision + 1,
        gapUnresolved: input.gapReconciled === true ? false :
          input.truncated === true ||
          input.gapUnresolved === true ||
          previous?.gapUnresolved === true ||
          previous?.truncated === true,
        ...(input.gapReconciled === true
          ? { reconciliationEvidenceId: input.reconciliationEvidenceId,
              reconciledAt: new Date().toISOString() }
          : {}),
        ...((input.truncated === true || input.gapUnresolved === true ||
          previous?.gapUnresolved === true || previous?.truncated === true)
          ? { gapDetectedAt: previous?.gapDetectedAt ??
              (typeof input.gapDetectedAt === 'string'
                ? input.gapDetectedAt : new Date().toISOString()) }
          : {}),
        ...(input.nextPollAt || previous?.nextPollAt
          ? { nextPollAt: String(input.nextPollAt || previous.nextPollAt) }
          : {}),
        ...(input.lastEventAt || previous?.lastEventAt
          ? { lastEventAt: String(input.lastEventAt || previous.lastEventAt) }
          : {}),
        ...(input.lastError ? { lastError: String(input.lastError) } : {}),
        ...(input.gapReconciled === true
          ? { truncated: false }
          : typeof input.truncated === 'boolean'
            ? { truncated: input.truncated }
          : typeof previous?.truncated === 'boolean'
            ? { truncated: previous.truncated }
            : {}),
      };
      await this.upsert('mcp_client_state', key, state, client);
      return state;
    });
  }

  getTemporalDeadline(deadlineId) {
    return this.get('temporal_deadline', String(deadlineId));
  }

  async listTemporalDeadlines({ triggerId, matchId, status } = {}) {
    return (await this.list('temporal_deadline'))
      .filter((item) => !triggerId || item.triggerId === String(triggerId))
      .filter((item) => !matchId || item.matchId === String(matchId))
      .filter((item) => !status || item.status === String(status));
  }

  async listDueTemporalDeadlines(nowIso) {
    const now = Date.parse(nowIso);
    return (await this.listTemporalDeadlines({ status: 'pending' }))
      .filter((item) => Date.parse(item.dueAt) <= now)
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  }

  async putTemporalDeadline(input) {
    const id = String(input.deadlineId || '');
    if (!id || !input.triggerId || !input.matchId || !input.conditionId) {
      throw new Error(
        'Temporal deadline requires deadlineId, triggerId, matchId and conditionId',
      );
    }
    return this.tx(async (client) => {
      await this.lock(client, 'temporal-deadline', id);
      const previous = await this.get('temporal_deadline', id, client);
      const now = new Date().toISOString();
      const record = {
        deadlineId: id,
        triggerId: String(input.triggerId),
        triggerVersion: String(input.triggerVersion || '1'),
        matchId: String(input.matchId),
        conditionId: String(input.conditionId),
        dueAt: String(input.dueAt),
        status: ['pending', 'cancelled', 'fired'].includes(input.status)
          ? input.status
          : previous?.status || 'pending',
        createdAt: previous?.createdAt || now,
        updatedAt: now,
      };
      if (!Number.isFinite(Date.parse(record.dueAt))) {
        throw new Error('Temporal deadline dueAt must be an ISO timestamp');
      }
      await this.upsert('temporal_deadline', id, record, client);
      return record;
    });
  }

  async setTemporalDeadlineStatus(deadlineId, status) {
    const current = await this.getTemporalDeadline(deadlineId);
    if (!current) return null;
    return this.putTemporalDeadline({ ...current, status });
  }

  getDerivedContract(eventName, contractVersion) {
    return this.get(
      'derived_contract',
      String(eventName) + '@' + String(contractVersion),
    );
  }

  async listDerivedContracts(eventName) {
    return (await this.list('derived_contract'))
      .filter((record) =>
        !eventName || record.eventName === String(eventName)
      )
      .sort((a, b) =>
        a.eventName.localeCompare(b.eventName) ||
        a.contractVersion.localeCompare(
          b.contractVersion,
          undefined,
          { numeric: true },
        )
      );
  }

  async putDerivedContract(input) {
    const key = String(input.eventName) + '@' + String(input.contractVersion);
    return this.tx(async (client) => {
      await this.lock(client, 'derived-contract', key);
      const previous = await this.get('derived_contract', key, client);
      const record = {
        eventName: String(input.eventName),
        contractVersion: String(input.contractVersion),
        payloadSchema:
          input.payloadSchema && typeof input.payloadSchema === 'object'
            ? input.payloadSchema
            : {},
        schemaFingerprint: String(input.schemaFingerprint),
        producers: Array.isArray(input.producers)
          ? input.producers.map((producer) => ({
              triggerId: String(producer.triggerId),
              triggerVersion: String(producer.triggerVersion),
            }))
          : previous?.producers ?? [],
        createdAt: previous?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await this.upsert('derived_contract', key, record, client);
      return record;
    });
  }

  getDerivedEvent(sourceEventId, serverId = 'event-intelligence:derived') {
    return this.get(
      'derived_event',
      String(serverId) + '::' + String(sourceEventId),
    );
  }

  async listDerivedEvents({ triggerId, matchId, name } = {}) {
    return (await this.list('derived_event'))
      .filter((record) =>
        !triggerId || record.triggerId === String(triggerId)
      )
      .filter((record) => !matchId || record.matchId === String(matchId))
      .filter((record) => !name || record.event.name === String(name));
  }

  async appendDerivedEvent(input) {
    const record = parseDerivedEventRecord(input);
    const key =
      String(record.event.serverId ?? '') + '::' + record.event.sourceEventId;
    const inserted = await this.insert('derived_event', key, record);
    return inserted
      ? { accepted: true, record }
      : { accepted: false, record: await this.get('derived_event', key) };
  }

  async getPartitionLease(partitionKey) {
    const result = await this.pool.query(
      'SELECT lease_key, owner_id, lease_until, updated_at FROM ' + this.leases +
      " WHERE scope_id = $1 AND lease_kind = 'partition' AND lease_key = $2",
      [this.scopeId, String(partitionKey || '')],
    );
    return leaseRow(result.rows[0]);
  }

  async claimPartitionLease(partitionKeyInput, {
    workerId,
    now = new Date().toISOString(),
    leaseMs = 30000,
  } = {}) {
    const partitionKey = String(partitionKeyInput || '').trim();
    const owner = String(workerId || '').trim();
    if (!partitionKey || !owner) {
      throw new Error('Partition lease requires partitionKey and workerId');
    }
    const until = new Date(
      Date.parse(now) + Math.max(1000, Number(leaseMs) || 30000),
    ).toISOString();
    const result = await this.pool.query(
      'INSERT INTO ' + this.leases +
      " (scope_id, lease_kind, lease_key, owner_id, lease_until, updated_at)" +
      " VALUES ($1, 'partition', $2, $3, $4::timestamptz, $5::timestamptz)" +
      ' ON CONFLICT (scope_id, lease_kind, lease_key) DO UPDATE SET' +
      ' owner_id = EXCLUDED.owner_id, lease_until = EXCLUDED.lease_until,' +
      ' updated_at = EXCLUDED.updated_at WHERE ' + this.leases +
      '.owner_id = EXCLUDED.owner_id OR ' + this.leases +
      '.lease_until <= $5::timestamptz' +
      ' RETURNING lease_key, owner_id, lease_until, updated_at',
      [this.scopeId, partitionKey, owner, until, String(now)],
    );
    return leaseRow(result.rows[0]);
  }

  async renewPartitionLease(partitionKeyInput, {
    workerId,
    now = new Date().toISOString(),
    leaseMs = 30000,
  } = {}) {
    const until = new Date(
      Date.parse(now) + Math.max(1000, Number(leaseMs) || 30000),
    ).toISOString();
    const result = await this.pool.query(
      'UPDATE ' + this.leases +
      ' SET lease_until = $4::timestamptz, updated_at = $3::timestamptz' +
      " WHERE scope_id = $1 AND lease_kind = 'partition' AND lease_key = $2" +
      ' AND owner_id = $5 RETURNING lease_key, owner_id, lease_until, updated_at',
      [
        this.scopeId,
        String(partitionKeyInput || '').trim(),
        String(now),
        until,
        String(workerId || '').trim(),
      ],
    );
    return leaseRow(result.rows[0]);
  }

  async releasePartitionLease(partitionKeyInput, { workerId } = {}) {
    const result = await this.pool.query(
      'DELETE FROM ' + this.leases +
      " WHERE scope_id = $1 AND lease_kind = 'partition'" +
      ' AND lease_key = $2 AND owner_id = $3',
      [
        this.scopeId,
        String(partitionKeyInput || '').trim(),
        String(workerId || '').trim(),
      ],
    );
    return result.rowCount > 0;
  }

  async compactMutableState({
    semanticCacheBefore,
    maxRows = 500,
  } = {}) {
    // This is deliberately NOT general event/audit/match retention. Wake
    // receipts, trigger definitions, leases, causal evidence and the append-only
    // audit hash chain remain intact. Only dispensable semantic model decision
    // caches may be reclaimed, with explicit host/operator cutoff.
    if (semanticCacheBefore === undefined) {
      return { ok: true, strategy: 'database-managed', compacted: [] };
    }
    if (!z.iso.datetime({ offset: true }).safeParse(semanticCacheBefore).success ||
        !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 1000) {
      const error = new TypeError(
        'Semantic cache compaction needs offset-aware ISO cutoff and maxRows 1..1000',
      );
      error.code = 'EVENT_INTELLIGENCE_RETENTION_POLICY_INVALID';
      throw error;
    }
    // For a legacy populated store, online migration is explicit, never
    // attempted implicitly during ordinary writes or trigger processing.
    await this.assertRetentionIndex();
    const result = await this.tx(async (client) => client.query(
      'WITH aged AS (' +
      ' SELECT record_key FROM ' + this.records +
      " WHERE scope_id = $1 AND kind = 'semantic_cache'" +
      ' AND updated_at < $2::timestamptz' +
      ' ORDER BY updated_at ASC, record_key ASC' +
      ' LIMIT $3 FOR UPDATE SKIP LOCKED' +
      ') DELETE FROM ' + this.records + ' AS retained' +
      ' USING aged WHERE retained.scope_id = $1' +
      " AND retained.kind = 'semantic_cache'" +
      ' AND retained.record_key = aged.record_key' +
      ' RETURNING retained.record_key',
      [this.scopeId, semanticCacheBefore, maxRows],
    ));
    return {
      ok: true,
      strategy: 'bounded-semantic-cache-retention',
      scopeId: this.scopeId,
      cutoff: semanticCacheBefore,
      deleted: result.rowCount,
      capped: result.rowCount === maxRows,
      // Caches are advisory. Future semantic evaluations recompute missing
      // decisions under their normal evaluator budget; no fake AI result.
      compacted: [{ kind: 'semantic_cache', records: result.rowCount }],
    };
  }

  async getSemanticDecisionCache(key) {
    const record = await this.get('semantic_cache', String(key || ''));
    return record?.decision ?? null;
  }

  async putSemanticDecisionCache(keyInput, decision) {
    const key = String(keyInput || '').trim();
    if (!key || !decision || typeof decision !== 'object') {
      throw new Error('Semantic decision cache requires key and decision');
    }
    return this.tx(async (client) => {
      await this.lock(client, 'semantic-cache', key);
      const previous = await this.get('semantic_cache', key, client);
      const now = new Date().toISOString();
      const record = {
        key,
        decision,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      await this.upsert('semantic_cache', key, record, client);
      return record;
    });
  }

  async semanticDecisionCacheSize() {
    const result = await this.pool.query(
      'SELECT count(*)::bigint AS count FROM ' + this.records +
      " WHERE scope_id = $1 AND kind = 'semantic_cache'",
      [this.scopeId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async appendAudit(input) {
    return this.tx(async (client) => {
      await this.lock(client, 'audit', 'chain');
      const previous = (await this.historyList('audit', undefined, client))
        .map(parseAuditRecord);
      const chain = new AuditChain(previous);
      const record = await chain.append(input);
      await this.appendHistory('audit', input.auditId, record, client);
      return record;
    });
  }

  /**
   * Operator snapshot: verifies every record from genesis, and returns the
   * tenant/genesis/terminal commitment. Pin this checkpoint independently
   * (off-host/WORM) before trusting later exported archive windows.
   */
  async getAuditCheckpoint() {
    return this.tx(async (client) => {
      await this.lock(client, 'audit', 'chain');
      const records = (await this.historyList('audit', undefined, client))
        .map(parseAuditRecord);
      if (!await new AuditChain(records).verify()) {
        const error = new Error('Cannot checkpoint a damaged audit chain');
        error.code = 'EVENT_INTELLIGENCE_AUDIT_PROOF_CHAIN_INVALID';
        throw error;
      }
      return {
        scopeId: this.scopeId,
        firstHash: records[0]?.hash ?? null,
        endSequence: records.length - 1,
        headHash: records.length ? records[records.length - 1].hash : null,
      };
    });
  }

  /** Bounded, nondestructive proof against one externally pinned snapshot. */
  async getAuditProofWindow({
    checkpoint,
    afterSequence = -1,
    limit = 100,
  } = {}) {
    if (!checkpoint || checkpoint.scopeId !== this.scopeId ||
        !Number.isSafeInteger(checkpoint.endSequence) ||
        checkpoint.endSequence < -1 ||
        !Number.isSafeInteger(afterSequence) || afterSequence < -1 ||
        afterSequence > checkpoint.endSequence ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 1000 ||
        (checkpoint.endSequence === -1 &&
          (checkpoint.firstHash !== null || checkpoint.headHash !== null)) ||
        (checkpoint.endSequence >= 0 &&
          (!checkpoint.firstHash || !checkpoint.headHash))) {
      const error = new TypeError(
        'Audit proof requires a scope-bound snapshot, bounded sequence and limit 1..1000',
      );
      error.code = 'EVENT_INTELLIGENCE_AUDIT_PROOF_POLICY_INVALID';
      throw error;
    }
    return this.tx(async (client) => {
      await this.lock(client, 'audit', 'chain');
      let terminalHistoryId = null;
      if (checkpoint.endSequence >= 0) {
        const first = await client.query(
          'SELECT payload FROM ' + this.history +
          ' WHERE scope_id=$1 AND kind=$2 ORDER BY history_id ASC LIMIT 1',
          [this.scopeId, 'audit'],
        );
        const terminal = await client.query(
          'SELECT history_id, payload FROM ' + this.history +
          ' WHERE scope_id=$1 AND kind=$2' +
          " AND (payload->>'sequence')::bigint=$3" +
          ' ORDER BY history_id ASC LIMIT 1',
          [this.scopeId, 'audit', checkpoint.endSequence],
        );
        if (!first.rows.length || !terminal.rows.length ||
            parseAuditRecord(first.rows[0].payload).hash !== checkpoint.firstHash ||
            parseAuditRecord(terminal.rows[0].payload).hash !== checkpoint.headHash) {
          const error = new Error('Stored audit snapshot no longer matches checkpoint');
          error.code = 'EVENT_INTELLIGENCE_AUDIT_PROOF_CHECKPOINT_MISMATCH';
          throw error;
        }
        terminalHistoryId = terminal.rows[0].history_id;
      }
      let previousHash = null;
      let previousHistoryId = null;
      if (afterSequence >= 0) {
        const prev = await client.query(
          'SELECT history_id, payload FROM ' + this.history +
          ' WHERE scope_id=$1 AND kind=$2' +
          " AND (payload->>'sequence')::bigint=$3" +
          ' ORDER BY history_id ASC LIMIT 1',
          [this.scopeId, 'audit', afterSequence],
        );
        if (prev.rows.length !== 1) {
          const error = new Error('Audit proof predecessor was not found');
          error.code = 'EVENT_INTELLIGENCE_AUDIT_PROOF_ANCHOR_MISSING';
          throw error;
        }
        previousHash = parseAuditRecord(prev.rows[0].payload).hash;
        previousHistoryId = prev.rows[0].history_id;
      }
      // Do NOT page by untrusted JSON sequence fields: a damaged sequence
      // in the last record must not silently disappear from the proof.
      let records = [];
      let hasMore = false;
      if (terminalHistoryId !== null) {
        const conditions = [
          'scope_id=$1', 'kind=$2', 'history_id<=$3',
        ];
        const args = [this.scopeId, 'audit', terminalHistoryId];
        if (previousHistoryId !== null) {
          conditions.push('history_id>$4');
          args.push(previousHistoryId);
        }
        args.push(limit + 1);
        const rows = await client.query(
          'SELECT payload FROM ' + this.history +
          ' WHERE ' + conditions.join(' AND ') +
          ' ORDER BY history_id ASC LIMIT ' +
          (previousHistoryId === null ? '$4' : '$5'),
          args,
        );
        records = rows.rows.slice(0, limit).map(row =>
          parseAuditRecord(row.payload)
        );
        hasMore = rows.rows.length > limit;
      }
      const proof = {
        scopeId: this.scopeId,
        afterSequence, previousHash, limit, records,
        endSequence: afterSequence + records.length,
        headHash: records.length
          ? records[records.length - 1].hash : previousHash,
        hasMore,
      };
      if (!await verifyAuditProofWindow(proof, {
        trustedCheckpoint: checkpoint,
        trustedAfterSequence: afterSequence,
        trustedPreviousHash: previousHash,
        trustedLimit: limit,
      })) {
        const error = new Error('Audit proof segment is not a valid pinned chain');
        error.code = 'EVENT_INTELLIGENCE_AUDIT_PROOF_CHAIN_INVALID';
        throw error;
      }
      return proof;
    });
  }

  async listAudit({ traceId, afterSequence = -1 } = {}) {
    return (await this.historyList('audit'))
      .map(parseAuditRecord)
      .filter((record) => record.sequence > afterSequence)
      .filter((record) => !traceId || record.traceId === traceId);
  }

  async trace(traceId) {
    const [wakes, matches, audit] = await Promise.all([
      this.historyList('wake'),
      this.listTriggerMatches(),
      this.listAudit({ traceId }),
    ]);
    return {
      wakes: wakes.filter((record) => record.traceId === traceId),
      triggerMatches: matches.filter((record) =>
        record.sourceEvents.some((event) => event.traceId === traceId)
      ),
      audit,
    };
  }

  async auditLength() {
    const result = await this.pool.query(
      'SELECT count(*)::bigint AS count FROM ' + this.history +
      " WHERE scope_id = $1 AND kind = 'audit'",
      [this.scopeId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async verifyAudit() {
    const chain = new AuditChain(
      (await this.historyList('audit')).map(parseAuditRecord),
    );
    return chain.verify();
  }

  async drain() {}

  async close() {
    if (this.ownsPool && typeof this.pool.end === 'function') {
      await this.pool.end();
    }
  }
}
