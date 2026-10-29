import * as z from 'zod/v4';
import { mcpGapSnapshot } from '../../dist/src/composite/gapFingerprint.js';
import { safeMcpSourceArguments } from './mcp-safe-arguments.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import { verifyAuditProofWindow } from './audit-proof-window.mjs';
import { assertAuditJsonNumberPrecision } from './audit-precision-safety.mjs';
import { mcpArchiveGenesis, mcpArchiveRecordHash, verifyMcpOccurrenceArchiveWindow } from './mcp-occurrence-archive.mjs';
export { verifyMcpOccurrenceArchiveWindow } from './mcp-occurrence-archive.mjs';
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
// Pre-v1 durable provider-state size policy. Prevent a single opaque cursor
// or nested source identity from defeating operator retention inventory caps.
const MCP_STATE_KEY_MAX_BYTES = 8192;
const MCP_STATE_PAYLOAD_MAX_BYTES = 16384;
const MCP_RETENTION_INVENTORY_MAX_BYTES = 8 * 1024 * 1024;

function quarantinedDispatchPoolError() {
  const error = new Error(
    'PostgreSQL dispatch pool has an uncertain session; recycle the physical pool before further host dispatch',
  );
  error.code = 'EVENT_INTELLIGENCE_DISPATCH_POOL_QUARANTINED';
  return error;
}

function poisonPoolFenceCapacity(pool) {
  // An uncertain PG advisory unlock may strand an entire session. Even if
  // one connection remains, there may NOT be enough capacity for store I/O
  // under a fenced host callback. Invalidate the shared admission identity
  // and wake all queued continuations with an explicit fail-closed error.
  const state = poolFenceSlots.get(pool);
  if (!state) return;
  state.poisoned = true;
  for (const waiter of state.waiters.splice(0)) {
    waiter.reject(quarantinedDispatchPoolError());
  }
}

async function withPoolFenceCapacity(pool, capacity, run) {
  let state = poolFenceSlots.get(pool);
  if (!state) {
    state = { active: 0, waiters: [], capacity, poisoned: false };
    poolFenceSlots.set(pool, state);
  }
  if (state.poisoned) throw quarantinedDispatchPoolError();
  if (state.capacity !== capacity) {
    // Multiple scope stores can share the same underlying pool. Reject
    // conflicting configured limits instead of silently over-admitting.
    const error = new Error('Conflicting fenced dispatch capacity for shared PostgreSQL pool');
    error.code = 'EVENT_INTELLIGENCE_DISPATCH_POOL_CAPACITY_MISMATCH';
    throw error;
  }
  // Admit at most floor(maxPool/2) fenced continuations per shared
  // pool. Contending lifecycle mutations use nonblocking try-lock/retry
  // and never pin all remaining PostgreSQL connections.
  if (state.active >= capacity) {
    // Directly transfer the releasing holder's slot to the oldest waiter,
    // without ever over-admitting. A poisoned gate rejects queued work.
    await new Promise((resolve, reject) => state.waiters.push({ resolve, reject }));
  } else {
    state.active++;
  }
  try {
    // The session may have been quarantined while this caller was queued.
    if (state.poisoned) throw quarantinedDispatchPoolError();
    return await run();
  } finally {
    if (state.poisoned) {
      for (const waiter of state.waiters.splice(0)) {
        waiter.reject(quarantinedDispatchPoolError());
      }
      state.active--;
    } else {
      const next = state.waiters.shift();
      if (next) next.resolve();
      else state.active--;
    }
  }
}

const POSTGRES_OBJECT_SUFFIXES = Object.freeze([
  '_records',
  '_records_kind_idx',
  '_records_age_idx',
  '_records_orphan_status_idx',
  '_records_wake_match_idx',
  '_records_match_trigger_idx',
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
    dispatchPoolMax = null,
    dispatchPoolIdentity = null,
    requireMcpSessionFence = false,
  } = {}) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
      throw new Error(
        'PostgresEventStore requires a pg-compatible pool with query() and connect()',
      );
    }
    if (dispatchPoolMax !== null &&
        (!Number.isSafeInteger(dispatchPoolMax) || dispatchPoolMax < 2)) {
      const error = new Error('dispatchPoolMax must be an integer >= 2 when provided');
      error.code = 'EVENT_INTELLIGENCE_DISPATCH_POOL_TOO_SMALL';
      throw error;
    }
    // For pg.Pool, options.max is authoritative. Pool wrappers without
    // options.max must explicitly assert their actual limit before dispatch.
    if (dispatchPoolIdentity !== null &&
        (typeof dispatchPoolIdentity !== 'object' || !dispatchPoolIdentity)) {
      throw new TypeError('dispatchPoolIdentity must be an object representing the physical pool');
    }
    this.requireMcpSessionFence = requireMcpSessionFence === true;
    this.dispatchPoolMax = dispatchPoolMax;
    this.dispatchPoolIdentity = dispatchPoolIdentity;
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
        if (freshRecords) {
          await client.query(
            'CREATE INDEX IF NOT EXISTS "' + this.tablePrefix +
            '_records_kind_idx" ON ' + this.records + ' (scope_id, kind)',
          );
        } else {
          await this.assertRecordsKindIndex(client);
        }
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

  async assertRecordsKindIndex(client = this.pool) {
    const indexName = this.tablePrefix + '_records_kind_idx';
    const legacyIndexName = indexName.toLowerCase();
    const indexNames = [...new Set([indexName, legacyIndexName])];
    const result = await client.query(
      'SELECT idx.relname AS name, i.indisvalid AS valid, i.indisready AS ready, ' +
      'i.indpred IS NOT NULL AS partial, i.indisunique AS is_unique, ' +
      'am.amname AS method, i.indnkeyatts AS key_count, ' +
      'tbl.relname AS table_name, ' +
      'pg_get_indexdef(i.indexrelid, 1, true) AS key1, ' +
      'pg_get_indexdef(i.indexrelid, 2, true) AS key2 ' +
      'FROM pg_class idx JOIN pg_index i ON i.indexrelid = idx.oid ' +
      'JOIN pg_class tbl ON tbl.oid = i.indrelid ' +
      'JOIN pg_am am ON am.oid = idx.relam ' +
      'JOIN pg_namespace n ON n.oid = idx.relnamespace ' +
      'WHERE n.nspname = current_schema() AND idx.relname = ANY($1::text[]) ' +
      'ORDER BY CASE WHEN idx.relname = $2 THEN 0 ELSE 1 END',
      [indexNames, indexName],
    );
    const row = result.rows[0];
    const normalize = value => String(value ?? '').replace(/\s+/g, '').replace(/[()]/g, '');
    if (!row || row.valid !== true || row.ready !== true || row.partial !== false ||
        row.is_unique !== false || row.method !== 'btree' ||
        row.table_name !== this.tablePrefix + '_records' || Number(row.key_count) !== 2 ||
        normalize(row.key1) !== 'scope_id' || normalize(row.key2) !== 'kind') {
      const error = new Error(
        'Existing Event Intelligence PostgreSQL records table needs a valid ' +
        '(scope_id, kind) index; inspect or repair ' + indexNames.join(' or ') + ' before startup.',
      );
      error.code = row
        ? 'EVENT_INTELLIGENCE_POSTGRES_RECORDS_KIND_INDEX_INVALID'
        : 'EVENT_INTELLIGENCE_POSTGRES_RECORDS_KIND_INDEX_REQUIRED';
      throw error;
    }
    return indexName;
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
      dispatchPoolMax: this.dispatchPoolMax,
      dispatchPoolIdentity: this.dispatchPoolIdentity,
      requireMcpSessionFence: this.requireMcpSessionFence,
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
    if (!record?.wakeId) throw new TypeError('Wake requires wakeId');
    // Keep all writers on the same PG transaction fence used by delivered
    // receipt materialization and operator-only history compaction.
    return this.tx(async (client) => {
      await this.lock(client, 'wake-delivered-history', String(record.wakeId));
      await this.appendHistory('wake', record.wakeId, record, client);
      return record;
    });
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

  /**
   * Opt-in terminal wake history compaction (#47).
   * No MCP occurrence, trigger match, dedup key, receipt, audit or distinct
   * wake transition may be removed. Dry-run by default. The per-wake
   * advisory lock fences BOTH appendWake and appendDeliveredWakeIfMissing
   * across independent PostgreSQL pools while the bounded window is read
   * and any deletions commit.
   */
  async compactDeliveredWakeDuplicateHistory({
    wakeId, before, maxRows = 100, maxHistoryRows = 10000,
    maxScanMs = 2000, dryRun = true,
  } = {}) {
    if (typeof wakeId !== 'string' || !wakeId.trim() ||
        !z.iso.datetime({ offset: true }).safeParse(before).success ||
        Date.parse(before) > Date.now() ||
        !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 1000 ||
        !Number.isSafeInteger(maxHistoryRows) ||
        maxHistoryRows < 3 || maxHistoryRows > 100000 ||
        !Number.isSafeInteger(maxScanMs) ||
        maxScanMs < 100 || maxScanMs > 30000 ||
        typeof dryRun !== 'boolean') {
      const error = new TypeError(
        'Wake history compaction needs wakeId, past offset-aware ISO cutoff, ' +
        'maxRows 1..1000, maxHistoryRows 3..100000, maxScanMs 100..30000 and boolean dryRun',
      );
      error.code = 'EVENT_INTELLIGENCE_WAKE_HISTORY_RETENTION_INVALID';
      throw error;
    }
    try {
      return await this.tx(async (client) => {
        // Abort the complete transaction if a dead-tuple index traversal or
        // advisory lock wait consumes the per-statement operator time budget.
        await client.query("SELECT set_config('statement_timeout', $1, true)",
          [String(maxScanMs) + 'ms']);
        await this.lock(client, 'wake-delivered-history', wakeId);
        const delivery = await this.get('wake_delivery', wakeId, client, true);
        // A pending, dead-letter or unreceipted wake can still be retried or
        // reconstructed. Never compact it, even if snapshots appear equal.
        if (delivery?.status !== 'delivered' ||
            typeof delivery.runtimeReceiptId !== 'string' ||
            !delivery.runtimeReceiptId) {
          return {
            ok: true, strategy: 'delivered-wake-adjacent-duplicate-retention',
            scopeId: this.scopeId, wakeId, dryRun, maxHistoryRows, maxScanMs,
            eligible: 0, deleted: 0, capped: false,
            skipped: 'not_durably_delivered',
          };
        }
        // Preserve both the first and last witnesses, and every transition,
        // even if a different state reappears later. Never delete last wake.
        const latest = await client.query(
          'SELECT payload FROM ' + this.history +
          ' WHERE scope_id=$1 AND kind=$2 AND record_key=$3' +
          ' ORDER BY history_id DESC LIMIT 1',
          [this.scopeId, 'wake', wakeId],
        );
        if (latest.rows[0]?.payload?.status !== 'delivered') {
          return {
            ok: true, strategy: 'delivered-wake-adjacent-duplicate-retention',
            scopeId: this.scopeId, wakeId, dryRun, maxHistoryRows, maxScanMs,
            eligible: 0, deleted: 0, capped: false,
            skipped: 'latest_wake_not_delivered',
          };
        }
        const overBudget = await client.query(
          'SELECT history_id FROM ' + this.history +
          ' WHERE scope_id=$1 AND kind=$2 AND record_key=$3' +
          ' ORDER BY history_id OFFSET $4 LIMIT 1',
          [this.scopeId, 'wake', wakeId, maxHistoryRows],
        );
        if (overBudget.rows.length) {
          const error = new Error(
            'Wake history exceeds operator scan budget; no revisions compacted');
          error.code = 'EVENT_INTELLIGENCE_WAKE_HISTORY_SCAN_BUDGET_EXCEEDED';
          throw error;
        }
        const sql =
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
        const params = [this.scopeId, 'wake', wakeId, before, maxRows];
        const selected = dryRun
          ? await client.query(sql + 'SELECT history_id FROM candidates', params)
          : await client.query(
            sql + 'DELETE FROM ' + this.history + ' h USING candidates c' +
            ' WHERE h.history_id=c.history_id AND h.scope_id=$1' +
            ' AND h.kind=$2 AND h.record_key=$3 RETURNING h.history_id',
            params,
          );
        const count = selected.rows.length;
        return {
          ok: true, strategy: 'delivered-wake-adjacent-duplicate-retention',
          scopeId: this.scopeId, wakeId, dryRun, maxHistoryRows, maxScanMs,
          eligible: count, deleted: dryRun ? 0 : count,
          capped: count === maxRows,
        };
      });
    } catch (error) {
      if (error?.code === '57014') {
        const bounded = new Error(
          'Wake history retention exceeded operator SQL time budget; no history was modified');
        bounded.code = 'EVENT_INTELLIGENCE_WAKE_HISTORY_TIME_BUDGET_EXCEEDED';
        throw bounded;
      }
      throw error;
    }
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

  async triggerMatchLookupIndexStatus() {
    const indexName = this.tablePrefix + '_records_match_trigger_idx';
    const result = await this.pool.query(
      'SELECT i.indisvalid AS valid, i.indisready AS ready, ' +
      'i.indpred IS NOT NULL AS partial, i.indisunique AS is_unique, ' +
      'am.amname AS method, i.indnkeyatts AS key_count, ' +
      'tbl.relname AS table_name, ' +
      'ARRAY[pg_get_indexdef(i.indexrelid, 1, true), ' +
      'pg_get_indexdef(i.indexrelid, 2, true)] AS key_columns, ' +
      'pg_get_expr(i.indpred, i.indrelid) AS predicate ' +
      'FROM pg_class idx JOIN pg_index i ON i.indexrelid = idx.oid ' +
      'JOIN pg_class tbl ON tbl.oid = i.indrelid ' +
      'JOIN pg_am am ON am.oid = idx.relam ' +
      'JOIN pg_namespace n ON n.oid = idx.relnamespace ' +
      'WHERE n.nspname = current_schema() AND idx.relname = $1',
      [indexName],
    );
    const row = result.rows[0];
    if (!row) return { exists: false, indexName };
    const normalize = value => String(value ?? '')
      .replace(/::text/g, '').replace(/\s+/g, '').replace(/[()]/g, '');
    const valid = row.valid === true && row.ready === true &&
      row.partial === true && row.is_unique === false &&
      row.method === 'btree' &&
      row.table_name === this.tablePrefix + '_records' &&
      Number(row.key_count) === 2 &&
      normalize(row.key_columns?.[0]) === 'scope_id' &&
      normalize(row.key_columns?.[1]) === "payload->>'triggerId'" &&
      normalize(row.predicate) === "kind='trigger_match'";
    return { exists: true, valid, indexName };
  }

  async assertTriggerMatchLookupIndex() {
    const status = await this.triggerMatchLookupIndexStatus();
    if (!status.valid) {
      const error = new Error(
        'PostgreSQL trigger-match lookup needs the verified scoped trigger index; ' +
        'run store.migrateTriggerMatchLookupIndex() after store.init() and inspect any conflicting index.',
      );
      error.code = status.exists
        ? 'EVENT_INTELLIGENCE_TRIGGER_MATCH_LOOKUP_INDEX_INVALID'
        : 'EVENT_INTELLIGENCE_TRIGGER_MATCH_LOOKUP_INDEX_REQUIRED';
      throw error;
    }
    return status.indexName;
  }

  /**
   * Safe online index migration for matching against a specific trigger.
   * A durable metadata claim serializes concurrent worker startup; the DDL
   * runs outside a transaction because CREATE INDEX CONCURRENTLY requires it.
   */
  async migrateTriggerMatchLookupIndex(options = {}) {
    const statementTimeoutMs = options.statementTimeoutMs ?? 900000;
    const waitTimeoutMs = options.waitTimeoutMs ?? statementTimeoutMs + 120000;
    if (!this.initialized) {
      const error = new Error('Initialize store before trigger-match index migration');
      error.code = 'EVENT_INTELLIGENCE_TRIGGER_MATCH_LOOKUP_MIGRATION_NOT_INITIALIZED';
      throw error;
    }
    if (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs < 1000 || waitTimeoutMs > 1020000) {
      throw new TypeError('waitTimeoutMs must be an integer from 1000 to 1020000');
    }
    if (!Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs < 1000 || statementTimeoutMs > 900000) {
      throw new TypeError('statementTimeoutMs must be an integer from 1000 to 900000');
    }
    const indexName = this.tablePrefix + '_records_match_trigger_idx';
    const existing = await this.triggerMatchLookupIndexStatus();
    if (existing.exists && existing.valid) {
      await this.assertTriggerMatchLookupIndex();
      return { ok: true, index: indexName };
    }

    const component = 'trigger-match-lookup-index-migration';
    const claim = randomUUID();
    const deadline = Date.now() + waitTimeoutMs;
    const migrationInProgress = async () => {
      const result = await this.pool.query(
        'SELECT 1 FROM ' + this.metadata + ' WHERE component=$1',
        [component],
      );
      return result.rows.length > 0;
    };
    if (existing.exists && !(await migrationInProgress())) {
      await this.assertTriggerMatchLookupIndex();
    }
    while (Date.now() < deadline) {
      const inserted = await this.tx(client => client.query(
        'INSERT INTO ' + this.metadata +
        ' (component, version, adopted_from) VALUES ($1, 1, $2)' +
        ' ON CONFLICT (component) DO NOTHING RETURNING component',
        [component, claim],
      ));
      if (inserted.rows.length === 1) {
        let verified = false;
        try {
          const beforeDdl = await this.triggerMatchLookupIndexStatus();
          if (!beforeDdl.exists) {
            const client = await this.pool.connect();
            let originalStatementTimeout;
            let discardClient = false;
            try {
              const setting = await client.query('SHOW statement_timeout');
              originalStatementTimeout = setting.rows[0]?.statement_timeout;
              if (typeof originalStatementTimeout !== 'string') {
                throw new Error('Could not read PostgreSQL statement_timeout before index migration');
              }
              await client.query("SELECT set_config('statement_timeout', $1, false)", [`${statementTimeoutMs}ms`]);
              await client.query(
              'CREATE INDEX CONCURRENTLY IF NOT EXISTS "' + indexName +
              '" ON ' + this.records +
                " (scope_id, (payload->>'triggerId')) WHERE kind = 'trigger_match'",
              );
            } catch (error) {
              discardClient = true;
              throw error;
            } finally {
              if (originalStatementTimeout !== undefined) {
                try {
                  await client.query("SELECT set_config('statement_timeout', $1, false)", [originalStatementTimeout]);
                } catch {
                  discardClient = true;
                }
              }
              client.release(discardClient ? new Error('Discard connection after trigger-match index migration') : undefined);
            }
          }
          await this.assertTriggerMatchLookupIndex();
          verified = true;
          return { ok: true, index: indexName };
        } finally {
          // Keep the durable claim if DDL or verification is ambiguous. An
          // operator must inspect the catalog before clearing a stale claim.
          if (verified) await this.pool.query(
            'DELETE FROM ' + this.metadata +
            ' WHERE component=$1 AND adopted_from=$2',
            [component, claim],
          );
        }
      }

      const status = await this.triggerMatchLookupIndexStatus();
      if (status.exists) {
        if (status.valid) {
          await this.assertTriggerMatchLookupIndex();
          return { ok: true, index: indexName };
        }
        if (!(await migrationInProgress())) {
          await this.assertTriggerMatchLookupIndex();
        }
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const error = new Error('Timed out waiting for trigger-match lookup index migration');
    error.code = 'EVENT_INTELLIGENCE_TRIGGER_MATCH_LOOKUP_MIGRATION_BUSY';
    throw error;
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
    const result = await this.pool.query(
      'SELECT d.payload FROM ' + this.records + ' AS d' +
      ' WHERE d.scope_id=$1 AND d.kind=$2 AND (' +
      " ((d.payload->>'status' IN ('pending','retry_pending')) AND (d.payload->>'nextAttemptAt')::timestamptz <= $3::timestamptz)" +
      " OR ((d.payload->>'status')='claimed' AND NULLIF(d.payload->>'leaseUntil','')::timestamptz <= $3::timestamptz)" +
      " OR ((d.payload->>'status')='delivered' AND (" +
      " COALESCE((SELECT h.payload->>'status' FROM " + this.history + " AS h WHERE h.scope_id=d.scope_id AND h.kind='wake' AND h.record_key=d.payload->>'wakeId' ORDER BY h.history_id DESC LIMIT 1),'') <> 'delivered'" +
      " OR COALESCE((SELECT m.payload->>'status' FROM " + this.records + " AS m WHERE m.scope_id=d.scope_id AND m.kind='trigger_match' AND m.record_key=d.payload->>'matchId' LIMIT 1),'') <> 'fired'" +
      ' )))' +
      " ORDER BY NULLIF(d.payload->>'nextAttemptAt','')::timestamptz NULLS LAST, d.record_key",
      [this.scopeId, 'wake_delivery', nowIso],
    );
    return result.rows.map(row => row.payload);
  }

  async countWakeDeliveryStates(nowIso = new Date().toISOString()) {
    const result = await this.pool.query(
      'SELECT' +
      " count(*) FILTER (WHERE payload->>'status' IN ('pending','retry_pending','claimed'))::integer AS pending," +
      " count(*) FILTER (WHERE payload->>'status'='dead_letter')::integer AS dead_letter," +
      " count(*) FILTER (WHERE payload->>'status'='delivered')::integer AS delivered," +
      " count(*) FILTER (WHERE ((payload->>'status' IN ('pending','retry_pending') AND (payload->>'nextAttemptAt')::timestamptz <= $2::timestamptz) OR (payload->>'status'='claimed' AND NULLIF(payload->>'leaseUntil','')::timestamptz <= $2::timestamptz)))::integer AS due" +
      ' FROM ' + this.records + ' WHERE scope_id=$1 AND kind=$3',
      [this.scopeId, nowIso, 'wake_delivery'],
    );
    return {
      pending: result.rows[0].pending,
      deadLetter: result.rows[0].dead_letter,
      delivered: result.rows[0].delivered,
      due: result.rows[0].due,
    };
  }

  async ensureWakeDelivery(input) {
    const wakeId = String(input.wakeId || '');
    const matchId = String(input.matchId || '');
    const runtime = String(input.runtime || '');
    // Preserve retry idempotence for earlier clients that omit version
    // on an ALREADY persisted wake. Never use an unpinned version to
    // create a new record.
    const existing = wakeId ? await this.getWakeDelivery(wakeId) : null;
    if (existing) return existing;
    const triggerVersion = typeof input.triggerVersion === 'string' &&
      input.triggerVersion.trim() ? input.triggerVersion : '';
    if (!wakeId || !matchId || !runtime || !triggerVersion) {
      throw new Error('Wake delivery requires wakeId, matchId, runtime and explicit triggerVersion');
    }
    const now = String(input.now ?? new Date().toISOString());
    const record = {
      wakeId,
      matchId,
      triggerId: String(input.triggerId || ''),
      triggerVersion,
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
      // The dispatch callback holds the matching session lock from its
      // final claim check until host/receipt/firing finish. Reclaim MUST NOT
      // race a live callback even if its time lease has elapsed.
      const active = await client.query(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',
        [this.tablePrefix + ':' + this.scopeId + ':wake-dispatch:' + wakeId],
      );
      if (active.rows[0]?.acquired !== true) return null;
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

  /**
   * A trigger-level dispatch fence may be busy while a DIFFERENT wake's
   * host callback runs. Preserve the claim generation (anti-ABA) but
   * release it with a short retry date and WITHOUT spending an actual
   * host-attempt budget. This is a scheduling delay, not a delivery error.
   */
  async deferBusyWakeDelivery(wakeIdInput, {
    workerId,
    attemptCount,
    now = new Date().toISOString(),
    nextAttemptAt = new Date(Date.parse(now) + 1000).toISOString(),
  } = {}) {
    const wakeId = String(wakeIdInput || '');
    return this.tx(async client => {
      const current = await this.get('wake_delivery', wakeId, client, true);
      if (!current) return null;
      assertWakeClaimGeneration(current, { workerId, attemptCount, wakeId });
      const record = {
        ...current,
        status: 'retry_pending',
        leaseOwner: null,
        leaseUntil: null,
        nextAttemptAt: String(nextAttemptAt),
        lastError: 'trigger_dispatch_busy',
        dispatchContentions: Number(current.dispatchContentions || 0) + 1,
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
      // attemptCount is the strictly monotonic ownership generation;
      // dispatch-contention claims never reached the host and must NOT
      // count toward retry/DLQ limits.
      const actualHostAttempts =
        Number(current.attemptCount || 0) -
        Number(current.dispatchContentions || 0);
      const terminal =
        actualHostAttempts >= Math.max(1, Number(maxAttempts) || 5);
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
    const lockKey = this.tablePrefix + ':' + this.scopeId + ':trigger-state:' + key;
    // Lifecycle mutations must never occupy ALL pool connections while
    // waiting for an in-flight host callback's session lock. A blocking
    // pg_advisory_xact_lock could deadlock if that callback needs the
    // same pool to hydrate/commit its durable receipt. Try non-blocking,
    // ROLLBACK and release the client before a bounded retry.
    const retryUntil = Date.now() + 30000;
    for (;;) {
      try {
        return await this.tx(async client => {
          const context = dispatchContext.getStore();
          const lifecycleReentrant =
            context?.store === this && context.key === key &&
            actor?.principal_id === 'event-intelligence:lifecycle';
          if (!lifecycleReentrant) {
            const attempt = await client.query(
              'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',
              [lockKey],
            );
            if (attempt.rows[0]?.acquired !== true) {
              const error = new Error('Lifecycle mutation waits for fenced host callback');
              error.code = 'EVENT_INTELLIGENCE_TRIGGER_STATE_LOCK_BUSY';
              throw error;
            }
          }
          const previous = await this.get('trigger_state', key, client) ??
            defaultTriggerState(triggerId, version);
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
            // Durable dispatch reservations survive pause/restart and are
            // only cleared by the matching lifecycle finalization.
            dispatchReservations:
              actor?.principal_id === 'event-intelligence:lifecycle' &&
              Array.isArray(metadata.dispatchReservations)
                ? metadata.dispatchReservations.map(String)
                : (Array.isArray(previous.dispatchReservations)
                  ? previous.dispatchReservations.map(String) : []),
            revision: Number(previous.revision || 0) + 1,
          };
          await this.upsert('trigger_state', key, next, client);
          return next;
        });
      } catch (error) {
        if (error?.code !== 'EVENT_INTELLIGENCE_TRIGGER_STATE_LOCK_BUSY') {
          throw error;
        }
        if (Date.now() >= retryUntil) {
          const timeout = new Error(
            'Trigger mutation could not acquire dispatch fence; retry later',
          );
          timeout.code = 'EVENT_INTELLIGENCE_TRIGGER_MUTATION_RETRY_REQUIRED';
          throw timeout;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  }

  /**
   * Fence the ACTUAL external host callback against concurrent pause/delete
   * commits. This session advisory lock has the SAME key as the transaction
   * lock in setTriggerState(). Revocation cannot commit until the callback
   * returns; a post-revocation attempt re-reads status under the lock.
   * Requires a session-preserving PostgreSQL connection (not transaction
   * pooling PgBouncer) and >=2 pool slots for callbacks that use the store.
   */
  async withTriggerDispatchFence(triggerId, version, at, operation, {
    wakeId = null, workerId = null, attemptCount = null,
  } = {}) {
    if (typeof operation !== 'function') throw new TypeError('dispatch callback required');
    const key = String(triggerId) + '@' + String(version);
    const exposedMax = this.pool.options?.max;
    const maxPool = this.dispatchPoolMax ?? exposedMax;
    if (!Number.isSafeInteger(maxPool) || maxPool < 2) {
      const error = new Error(
        'Fenced PG dispatch requires a verified pool limit >=2; ' +
        'set dispatchPoolMax for pool wrappers without options.max',
      );
      error.code = Number.isSafeInteger(maxPool)
        ? 'EVENT_INTELLIGENCE_DISPATCH_POOL_TOO_SMALL'
        : 'EVENT_INTELLIGENCE_DISPATCH_POOL_SIZE_UNKNOWN';
      throw error;
    }
    if (Number.isSafeInteger(exposedMax) && maxPool > exposedMax) {
      const error = new Error('dispatchPoolMax exceeds PostgreSQL pool options.max');
      error.code = 'EVENT_INTELLIGENCE_DISPATCH_POOL_CAPACITY_MISMATCH';
      throw error;
    }
    // Wrapper identity is not necessarily pool identity: multiple wrappers
    // can share ONE physical max=2 pool. They must pass the same underlying
    // pool object as dispatchPoolIdentity, or admission queues can each
    // occupy one session and deadlock during callback DB I/O.
    // No structural check can prove a pool object is the underlying physical
    // pool: wrappers can forward options.max and have separate JS identities.
    // Require an explicit stable identity for EVERY dispatch-capable store,
    // including direct pg.Pool clients, so wrappers cannot split the gate.
    if (!this.dispatchPoolIdentity) {
      const error = new Error(
        'Fenced PostgreSQL dispatch requires dispatchPoolIdentity for the physical connection pool',
      );
      error.code = 'EVENT_INTELLIGENCE_DISPATCH_POOL_IDENTITY_REQUIRED';
      throw error;
    }
    const capacityIdentity = this.dispatchPoolIdentity;
    const observedAt = Date.now();
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) throw new TypeError('dispatch time must be valid ISO');
    const lockKey = this.tablePrefix + ':' + this.scopeId + ':trigger-state:' + key;

    // At most floor(max/2) concurrent fenced continuations. A competing
    // pause/delete uses a nonblocking advisory try-lock and releases the
    // connection during retry, so the callback always has a free slot.
    const capacity = Math.max(1, Math.floor(maxPool / 2));
    return withPoolFenceCapacity(capacityIdentity, capacity, async () => {
      const client = await this.pool.connect();
      let locked = false;
      let wakeLocked = false;
      const wakeLockKey = this.tablePrefix + ':' + this.scopeId +
        ':wake-dispatch:' + String(wakeId);
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
        // The claim may have expired and been reclaimed while waiting in
        // withPoolFenceCapacity. Acquire the SAME advisory key that every
        // PostgreSQL claim transaction try-locks, then check the authoritative
        // generation/owner/lease BEFORE any external host effect.
        // Keeping the session lock through receipt and markFired prevents a
        // successor from reclaiming mid-callback even after the time lease.
        if (workerId !== null || attemptCount !== null) {
          if (typeof wakeId !== 'string' || !wakeId ||
              typeof workerId !== 'string' || !workerId ||
              !Number.isSafeInteger(attemptCount) || attemptCount < 1) {
            throw new TypeError('fenced claimed dispatch requires wakeId, workerId and attemptCount');
          }
          const wakeFence = await client.query(
            'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',
            [wakeLockKey],
          );
          if (wakeFence.rows[0]?.acquired !== true) {
            return { authorized: false, reason: 'wake_claim_lost' };
          }
          wakeLocked = true;
          const owned = await this.get('wake_delivery', wakeId, client);
          const effectiveClaimAt = atMs + Math.max(0, Date.now() - observedAt);
          if (owned?.status !== 'claimed' ||
              owned.leaseOwner !== workerId ||
              owned.attemptCount !== attemptCount ||
              !owned.leaseUntil ||
              Date.parse(owned.leaseUntil) <= effectiveClaimAt) {
            return { authorized: false, reason: 'wake_claim_lost' };
          }
        }
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
        const pending = Array.isArray(state.dispatchReservations)
          ? state.dispatchReservations : [];
        const cap = lifecycle.oneShot === true || lifecycle.completeOnGoal === true
          ? 1
          : (lifecycle.maxFirings === undefined
            ? Number.POSITIVE_INFINITY : lifecycle.maxFirings);
        const alreadyReserved = typeof wakeId === 'string' && pending.includes(wakeId);
        // Revalidate wall-clock authorization AFTER the admission queue and
        // session-lock acquisition, not at the original call entry. Preserve
        // virtual test-clock semantics by adding actual elapsed waiting time.
        const effectiveAtMs = atMs + Math.max(0, Date.now() - observedAt);
        if (!definition?.target || state.status !== 'active' ||
            effectiveAtMs > Math.min(expiresAt, leaseUntil) ||
            (Number.isFinite(cap) && count + pending.length >= cap &&
              !alreadyReserved)) {
          return { authorized: false, reason: 'trigger_not_active_at_dispatch' };
        }
        // Commit the right to execute a bounded trigger BEFORE calling the
        // external host. A worker crash releases its session lock, but a
        // durable reservation for that wake remains, blocking other wake
        // IDs from consuming the same one-shot / maxFirings slot.
        if (Number.isFinite(cap) && !alreadyReserved) {
          if (typeof wakeId !== 'string' || !wakeId) {
            const error = new Error('Bounded host dispatch requires durable wake identity');
            error.code = 'EVENT_INTELLIGENCE_DISPATCH_WAKE_ID_REQUIRED';
            throw error;
          }
          await client.query('BEGIN');
          try {
            const previous = await this.get('trigger_state', key, client, true) ??
              defaultTriggerState(triggerId, version);
            const original = Array.isArray(previous.dispatchReservations)
              ? previous.dispatchReservations : [];
            if (previous.status !== 'active' ||
                (previous.fireCount ?? 0) + original.length >= cap) {
              await client.query('ROLLBACK');
              return { authorized: false, reason: 'trigger_not_active_at_dispatch' };
            }
            await this.upsert('trigger_state', key, {
              ...previous,
              dispatchReservations: [...original, wakeId],
              revision: Number(previous.revision || 0) + 1,
              updatedAt: new Date().toISOString(),
            }, client);
            await client.query('COMMIT');
          } catch (error) {
            try { await client.query('ROLLBACK'); } catch {}
            throw error;
          }
        }
        // The callback includes durable receipt and lifecycle finalization.
        // If execution crashes before markFired, the SAME wake can retry
        // while a DIFFERENT wake is fenced by the persisted reservation.
        const value = await dispatchContext.run({ store: this, key }, operation);
        return { authorized: true, value };
      } finally {
        if (locked || wakeLocked) {
          try {
            if (wakeLocked) {
              const unlocked = await client.query(
                'SELECT pg_advisory_unlock(hashtextextended($1,0)) AS released',
                [wakeLockKey],
              );
              if (unlocked.rows[0]?.released !== true) {
                throw new Error('Wake dispatch session advisory unlock failed');
              }
            }
            if (locked) {
              const unlocked = await client.query(
                'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released',
                [lockKey],
              );
              if (unlocked.rows[0]?.released !== true) {
                throw new Error('Trigger dispatch session advisory unlock failed');
              }
            }
            client.release();
          } catch (error) {
            // Generic PostgresPoolLike wrappers may silently IGNORE the
            // release(error) destruction hint. Returning a possibly
            // session-locked client would poison future trigger dispatches.
            // Quarantine this checked-out connection instead: no release()
            // call, so the pool CANNOT reuse it. Poison the shared physical
            // admission gate too: a max=2 pool now has only one usable slot,
            // which cannot support a host callback that performs store I/O.
            // Every queued/new dispatch is rejected until pool replacement.
            poisonPoolFenceCapacity(capacityIdentity);
            const uncertain = new Error(
              'Fenced PostgreSQL advisory unlock failed: quarantine session and recycle pool',
              { cause: error },
            );
            uncertain.code = 'EVENT_INTELLIGENCE_DISPATCH_SESSION_QUARANTINED';
            throw uncertain;
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

  /**
   * Operator-only, READ-ONLY preflight inventory for a future source replay
   * floor. Locks all concurrent source-state mutations and MCP appends
   * while taking one scope-local SQL snapshot. It NEVER authorizes pruning.
   *
   * An opaque provider cursor cannot be ordered against EI's numeric source
   * occurrence sequence. A clean snapshot is NOT a watermark or proof that
   * a provider can replay archived events.
   */
  async inspectMcpSourceRetentionBarriers({
    maxSources = 1024, maxScanMs = 5000,
  } = {}) {
    if (!Number.isSafeInteger(maxSources) || maxSources < 1 ||
        maxSources > 16384 ||
        !Number.isSafeInteger(maxScanMs) || maxScanMs < 100 ||
        maxScanMs > 30000) {
      const error = new TypeError('MCP source retention inventory needs bounded sources and SQL budget');
      error.code = 'EVENT_INTELLIGENCE_MCP_RETENTION_POLICY_INVALID';
      throw error;
    }
    try {
      return await this.tx(async client => {
        await client.query("SELECT set_config('statement_timeout', $1, true)",
          [String(maxScanMs) + 'ms']);
        // Ordered scope fences: provider state writes take the gap fence;
        // occurrence appends take the source sequence fence. No lock is held
        // after this method returns, so a later prune MUST revalidate.
        await this.lock(client, 'mcp-gap-fence', 'scope');
        await this.lock(client, 'mcp-archive-sequence', 'scope');
        const tail = await client.query(
          'SELECT value::text AS original FROM ' + this.counters +
          ' WHERE scope_id=$1 AND name=$2',
          [this.scopeId, 'mcp_occurrence'],
        );
        const rawTail = tail.rows[0]?.original ?? '0';
        const sourceTailSequence = Number(rawTail);
        if (!Number.isSafeInteger(sourceTailSequence) ||
            sourceTailSequence < 0 || String(sourceTailSequence) !== rawTail) {
          const error = new Error('Source sequence is invalid for retention inventory');
          error.code = 'EVENT_INTELLIGENCE_MCP_RETENTION_STATE_INVALID';
          throw error;
        }
        // Inspect aggregate stored size BEFORE fetching any large JSONB
        // payload into Node. Scope fences prevent normal concurrent MCP
        // writers from invalidating the measured budget before this read.
        const size = await client.query(
          'SELECT COUNT(*)::int AS rows, ' +
          // octet_length(payload::text) measures decoded logical JSON,
          // NOT TOAST-compressed pg_column_size on a repetitive payload.
          'COALESCE(SUM(octet_length(payload::text)::bigint + ' +
          'octet_length(record_key)::bigint),0)::text AS total_bytes, ' +
          'COALESCE(MAX(octet_length(payload::text)),0)::int AS max_row_bytes, ' +
          'COALESCE(MAX(octet_length(record_key)),0)::int AS max_key_bytes ' +
          'FROM ' + this.records + ' WHERE scope_id=$1 AND kind=$2',
          [this.scopeId, 'mcp_client_state'],
        );
        const measurements = size.rows[0];
        if (!measurements || measurements.rows > maxSources ||
            Number(measurements.total_bytes) > MCP_RETENTION_INVENTORY_MAX_BYTES ||
            measurements.max_row_bytes > MCP_STATE_PAYLOAD_MAX_BYTES ||
            measurements.max_key_bytes > MCP_STATE_KEY_MAX_BYTES) {
          const error = new Error('MCP client states exceed bounded retention inventory bytes or rows');
          error.code = 'EVENT_INTELLIGENCE_MCP_RETENTION_SCAN_BUDGET_EXCEEDED';
          throw error;
        }
        const saved = await client.query(
          'SELECT record_key,payload::text AS raw FROM ' + this.records +
          ' WHERE scope_id=$1 AND kind=$2 ORDER BY record_key LIMIT $3',
          [this.scopeId, 'mcp_client_state', maxSources + 1],
        );
        if (saved.rows.length > maxSources) {
          const error = new Error('MCP source retention inventory exceeds bounded scope');
          error.code = 'EVENT_INTELLIGENCE_MCP_RETENTION_SCAN_BUDGET_EXCEEDED';
          throw error;
        }
        const blockers = new Set([
          'opaque-provider-cursor-to-sequence-floor-unproven',
          'off-host-immutable-source-and-audit-archive-unverified',
          'pending-cep-wake-and-dedup-lifecycle-unverified',
          'audit-prefix-hash-continuation-unverified',
        ]);
        if (!saved.rows.length) blockers.add('no-registered-provider-state');
        const sources = [];
        for (const {record_key:recordKey,raw} of saved.rows) {
          let state;
          try {
            assertAuditJsonNumberPrecision(raw);
            state=JSON.parse(raw);
          } catch {
            const error = new Error('Malformed or lossy durable MCP state prevents retention inventory');
            error.code = 'EVENT_INTELLIGENCE_MCP_RETENTION_STATE_INVALID';
            throw error;
          }
          let expectedKey;
          try {
            expectedKey=mcpStateKey(
              state?.connectionId,state?.eventName,state?.arguments);
          } catch {
            // Tampered/invalid stored identity is NOT a valid source census.
          }
          if (typeof recordKey !== 'string' ||
              expectedKey !== recordKey ||
              typeof state?.connectionId !== 'string' || !state.connectionId ||
              typeof state.eventName !== 'string' || !state.eventName ||
              !Number.isSafeInteger(state.completenessRevision) ||
              state.completenessRevision < 1 ||
              typeof state.gapUnresolved !== 'boolean' ||
              (state.truncated !== undefined &&
                typeof state.truncated !== 'boolean')) {
            const error = new Error('Untrusted MCP source identity/revision in retention inventory');
            error.code = 'EVENT_INTELLIGENCE_MCP_RETENTION_STATE_INVALID';
            throw error;
          }
          const hasOpaqueCursor = typeof state.cursor === 'string' &&
            state.cursor.length > 0;
          const gapUnresolved = state.gapUnresolved === true ||
            state.truncated === true;
          if (!hasOpaqueCursor) blockers.add('missing-opaque-provider-cursor');
          if (gapUnresolved) blockers.add('unreconciled-provider-delivery-gap');
          sources.push(Object.freeze({
            identitySha256:createHash('sha256').update(
              JSON.stringify([this.scopeId,recordKey]),'utf8').digest('hex'),
            completenessRevision:state.completenessRevision,
            cursorSha256:hasOpaqueCursor
              ? createHash('sha256').update(state.cursor,'utf8').digest('hex')
              : null,
            gapUnresolved,
            // No raw provider tokens, arguments or full connection IDs leave
            // this operator report; the hash still must be treated as scoped.
          }));
        }
        const snapshotSha256 = createHash('sha256').update(JSON.stringify([
          'event-intelligence.mcp-retention-source-inventory.v1',
          this.scopeId,sourceTailSequence,sources,
        ]),'utf8').digest('hex');
        return Object.freeze({
          schema:'event-intelligence.mcp-retention-source-inventory.v1',
          scopeId:this.scopeId,sourceTailSequence,
          sourceCount:sources.length,
          sources:Object.freeze(sources),
          snapshotSha256,
          blockers:Object.freeze([...blockers].sort()),
          // The returned inventory is informative only, NOT trusted:
          // callers cannot conclude that archived history is deletable.
          physicalSourcePruneAuthorized:false,
          productionReplayFloorEstablished:false,
        });
      });
    } catch (error) {
      if (error?.code === '57014') {
        const bounded = new Error('MCP source retention inventory SQL budget exceeded');
        bounded.code = 'EVENT_INTELLIGENCE_MCP_RETENTION_TIME_BUDGET_EXCEEDED';
        throw bounded;
      }
      throw error;
    }
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
    const isFiredWake = record.status === 'fired' &&
      typeof record.firedWakeId === 'string' && record.firedWakeId;
    const key = String(record.triggerId) + '@' + String(record.triggerVersion);
    const lockKey = this.tablePrefix + ':' + this.scopeId + ':trigger-state:' + key;
    const deadline = Date.now() + 15000;

    // The match transition and its RESERVED firing-count/lifecycle update
    // MUST commit in the SAME transaction. If SIGKILL occurs, PostgreSQL
    // commits either BOTH or NEITHER; no fired match can strand a reserved
    // slot or leave its fireCount permanently stale.
    for (;;) {
      try {
        return await this.tx(async (client) => {
          const ctx = dispatchContext.getStore();
          const ownsFencedSession = isFiredWake &&
            ctx?.store === this && ctx.key === key;
          if (isFiredWake && !ownsFencedSession) {
            const lock = await client.query(
              'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',
              [lockKey],
            );
            if (lock.rows[0]?.acquired !== true) {
              const error = new Error('Trigger state is held by a dispatch fence');
              error.code = 'EVENT_INTELLIGENCE_TRIGGER_STATE_LOCK_BUSY';
              throw error;
            }
          }
          await this.lock(client, 'trigger-match', record.matchId);
          const current = await this.get('trigger_match', record.matchId, client);
          if (!current || !expected.has(current.status)) {
            return {
              applied: false,
              record: current ? parseTriggerMatchRecord(current) : null,
              lifecycleFinalized: false,
            };
          }
          let lifecycleFinalized = false;
          let lifecycleCompleted = false;
          let fireCount = null;
          if (isFiredWake) {
            const state = await this.get('trigger_state', key, client, true) ??
              defaultTriggerState(record.triggerId, record.triggerVersion);
            const reserved = Array.isArray(state.dispatchReservations)
              ? state.dispatchReservations : [];
            if (reserved.includes(record.firedWakeId)) {
              const raw = await this.get('trigger', key, client);
              const definition = raw ? parseCompositeTriggerDefinition(raw) : null;
              if (!definition) throw new Error('Reserved trigger definition vanished');
              const lifecycle = definition.lifecycle ?? {};
              fireCount = Number(state.fireCount ?? 0) + 1;
              lifecycleCompleted =
                lifecycle.oneShot === true ||
                lifecycle.completeOnGoal === true ||
                (lifecycle.maxFirings !== undefined &&
                  fireCount >= lifecycle.maxFirings);
              await this.upsert('trigger_state', key, {
                ...state,
                // An intervening administrative pause/delete is never undone.
                status: state.status === 'active'
                  ? (lifecycleCompleted ? 'completed' : 'active')
                  : state.status,
                actor: {
                  type: 'system',
                  principal_id: 'event-intelligence:lifecycle',
                },
                fireCount,
                lastFiredAt: new Date().toISOString(),
                dispatchReservations: reserved.filter(
                  wakeId => wakeId !== record.firedWakeId),
                updatedAt: new Date().toISOString(),
                revision: Number(state.revision || 0) + 1,
              }, client);
              lifecycleFinalized = true;
            }
          }
          await this.appendHistory('trigger_match_history',
            record.matchId, record, client);
          await this.upsert('trigger_match', record.matchId, record, client);
          return { applied: true, record, lifecycleFinalized,
            lifecycleCompleted, fireCount };
        });
      } catch (error) {
        if (error?.code !== 'EVENT_INTELLIGENCE_TRIGGER_STATE_LOCK_BUSY') throw error;
        if (Date.now() >= deadline) {
          const timeout = new Error('Fired match finalization must retry after dispatch');
          timeout.code = 'EVENT_INTELLIGENCE_TRIGGER_MUTATION_RETRY_REQUIRED';
          throw timeout;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  }

  /** Exact, scope-bound current match lookup; avoids materializing every match. */
  async getTriggerMatch(matchId) {
    const raw = await this.get('trigger_match', String(matchId));
    return raw ? parseTriggerMatchRecord(raw) : null;
  }

  /**
   * Scope-local latest-match selector: single result row instead of
   * deserializing every match for a trigger in the Node inspector.
   * Date.parse truncates submillisecond fractions; date_trunc matches its
   * millisecond timestamp ordering before applying the status tie-break.
   * Existing PostgreSQL indexes restrict scope/kind; this query may still
   * scan/sort matches server-side until a dedicated index is deployed.
   */
  async getLatestTriggerMatch(triggerId, version) {
    const result = await this.pool.query(
      'SELECT payload FROM ' + this.records +
      " WHERE scope_id=$1 AND kind='trigger_match'" +
      " AND payload->>'triggerId'=$2 AND payload->>'triggerVersion'=$3" +
      " ORDER BY date_trunc('millisecond', (payload->>'updatedAt')::timestamptz) DESC," +
      " CASE" +
      " WHEN payload->>'status'='fired' THEN 5" +
      " WHEN payload->>'status'='emitted' THEN 4" +
      " WHEN payload->>'status'='matched' THEN 3" +
      " WHEN payload->>'status'='partial' AND" +
      " payload->'patternState'->>'role'='match' THEN 2" +
      " WHEN payload->>'status'='partial' THEN 1 ELSE 0 END DESC," +
      ' record_key ASC LIMIT 1',
      [this.scopeId, String(triggerId), String(version)],
    );
    const raw = result.rows[0]?.payload;
    const record = raw ? parseTriggerMatchRecord(raw) : null;
    return record?.triggerId === triggerId &&
      record?.triggerVersion === version ? record : null;
  }

  async listTriggerMatches(triggerId) {
    const result = triggerId
      ? await this.pool.query(
          'SELECT payload FROM ' + this.records +
          ' WHERE scope_id=$1 AND kind=\'trigger_match\' AND payload->>\'triggerId\'=$2' +
          ' ORDER BY record_key',
          [this.scopeId, String(triggerId)],
        )
      : await this.pool.query(
          'SELECT payload FROM ' + this.records +
          ' WHERE scope_id=$1 AND kind=\'trigger_match\' ORDER BY record_key',
          [this.scopeId],
        );
    return result.rows.map(row => parseTriggerMatchRecord(row.payload));
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
  /**
   * Paginated, scope-local operator sweep of ONLY redundant terminal
   * snapshots. This never deletes audit, source occurrences, source dedup,
   * active matches, pending wakes or any authoritative receipt/record.
   * Run with dryRun=true first. Each selected key commits independently;
   * preserve nextAfterKey when an operator run is interrupted.
   */
  async compactScopedTerminalHistoryBatch({
    kind, before, afterKey = '', maxKeys = 10, maxRows = 100,
    maxHistoryRows = 10000, maxScanMs = 2000, dryRun = true,
  } = {}) {
    const validKind = kind === 'wake' || kind === 'trigger_match_history';
    if (!validKind || !z.iso.datetime({offset:true}).safeParse(before).success ||
        Date.parse(before) > Date.now() ||
        typeof afterKey !== 'string' ||
        !Number.isSafeInteger(maxKeys) || maxKeys < 1 || maxKeys > 32 ||
        !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 1000 ||
        !Number.isSafeInteger(maxHistoryRows) ||
        maxHistoryRows < 3 || maxHistoryRows > 100000 ||
        !Number.isSafeInteger(maxScanMs) ||
        maxScanMs < 100 || maxScanMs > 30000 ||
        typeof dryRun !== 'boolean') {
      const error = new TypeError(
        'Scope retention sweep requires wake/match history kind, past ISO cutoff, ' +
        'afterKey, maxKeys 1..32, maxRows 1..1000, maxHistoryRows 3..100000, ' +
        'maxScanMs 100..30000 and boolean dryRun',
      );
      error.code = 'EVENT_INTELLIGENCE_TERMINAL_SWEEP_POLICY_INVALID';
      throw error;
    }
    let keys;
    try {
      keys = await this.tx(async client => {
        await client.query("SELECT set_config('statement_timeout', $1, true)",
          [String(maxScanMs) + 'ms']);
        const found = await client.query(
          'SELECT DISTINCT record_key FROM ' + this.history +
          ' WHERE scope_id=$1 AND kind=$2 AND record_key>$3' +
          ' ORDER BY record_key LIMIT $4',
          [this.scopeId, kind, afterKey, maxKeys + 1],
        );
        return found.rows.map(row => String(row.record_key));
      });
    } catch (error) {
      if (error?.code === '57014') {
        const bounded = new Error('Scoped terminal retention key scan exceeded SQL time budget');
        bounded.code = 'EVENT_INTELLIGENCE_TERMINAL_SWEEP_TIME_BUDGET_EXCEEDED';
        throw bounded;
      }
      throw error;
    }
    const examined = keys.slice(0, maxKeys);
    const rows = [];
    let cursor = afterKey;
    let cappedKey = null;
    // The underlying per-key functions hold the existing writer fences and
    // revalidate current authoritative states on independent transactions.
    // Never assume a cached key scan itself authorizes deletion.
    for (const key of examined) {
      const settings = {
        before, maxRows, maxHistoryRows, maxScanMs, dryRun,
      };
      let outcome;
      try {
        outcome = kind === 'wake'
          ? await this.compactDeliveredWakeDuplicateHistory({
            wakeId: key, ...settings,
          })
          : await this.compactTerminalMatchDuplicateHistory({
            matchId: key, ...settings,
          });
      } catch (error) {
        // Earlier keys were independent committed transactions. Do not
        // pretend the whole batch rolled back or discard the operator's
        // exact last committed cursor on a failure at this key.
        if (error && typeof error === 'object') {
          error.partialProgress = Object.freeze({
            scopeId: this.scopeId, kind, before, dryRun,
            afterKey, nextAfterKey: cursor, failedKey: key,
            inspected: rows.length,
            eligible: rows.reduce((sum, row) => sum + row.eligible, 0),
            deleted: rows.reduce((sum, row) => sum + row.deleted, 0),
            rows: Object.freeze([...rows]),
            hasMore: true,
          });
        }
        throw error;
      }
      rows.push({key, ...outcome});
      if (outcome.capped) {
        // Do not advance past a key with unprocessed duplicates. Even
        // exactly-maxRows may require one harmless recheck next page.
        // Dry-run is always a preview, not a cursor-draining campaign.
        cappedKey = key;
        break;
      }
      cursor = key;
    }
    return {
      ok: true, strategy: 'scoped-terminal-duplicate-history-sweep-v1',
      scopeId: this.scopeId, kind, before, dryRun,
      afterKey, maxKeys, maxRows, maxHistoryRows, maxScanMs,
      nextAfterKey: cursor,
      cappedKey,
      hasMore: cappedKey !== null || keys.length > maxKeys,
      inspected: rows.length,
      eligible: rows.reduce((sum, row) => sum + row.eligible, 0),
      deleted: rows.reduce((sum, row) => sum + row.deleted, 0),
      rows,
      excludes: ['mcp_occurrence','mcp_occurrence_key','audit',
        'wake_delivery','trigger_match','nonterminal_keys'],
    };
  }

  async compactTerminalMatchDuplicateHistory({
    matchId,
    before,
    maxRows = 100,
    maxHistoryRows = 10000,
    // Visible-row OFFSET cannot cap dead index tuple traversal; bound
    // physical SQL execution TIME for each query while under writer lock.
    maxScanMs = 2000,
    dryRun = true,
  } = {}) {
    if (typeof matchId !== 'string' || !matchId.trim() ||
        !z.iso.datetime({ offset: true }).safeParse(before).success ||
        Date.parse(before) > Date.now() ||
        !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 1000 ||
        !Number.isSafeInteger(maxHistoryRows) || maxHistoryRows < 3 ||
        maxHistoryRows > 100000 ||
        !Number.isSafeInteger(maxScanMs) || maxScanMs < 100 || maxScanMs > 30000 ||
        typeof dryRun !== 'boolean') {
      const error = new TypeError(
        'Match history compaction needs matchId, past offset-aware ISO cutoff, ' +
        'maxRows 1..1000, maxHistoryRows 3..100000, maxScanMs 100..30000 and boolean dryRun',
      );
      error.code = 'EVENT_INTELLIGENCE_MATCH_HISTORY_RETENTION_INVALID';
      throw error;
    }
    try {
    return await this.tx(async (client) => {
      // Physical PostgreSQL work is NOT proportional to OFFSET visible rows
      // when dead index entries await VACUUM. Fail closed after at most
      // maxScanMs per SQL statement, including lock acquisition and window
      // scan, rather than holding the match writer fence indefinitely.
      // Transaction-local setting rolls back automatically on commit/abort.
      await client.query(
        "SELECT set_config('statement_timeout', $1, true)",
        [String(maxScanMs) + 'ms'],
      );
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
      // applying cutoff and maxRows. Reject over-budget histories BEFORE
      // deletion, without either a full COUNT(*) or an unlimited window
      // materialization. OFFSET caps VISIBLE rows only, not physical index
      // tuple traversal; the SQL statement timeout above supplies the
      // independent bounded-time guard under the match writer fence.
      const overBudget = await client.query(
        'SELECT history_id FROM ' + this.history +
        ' WHERE scope_id=$1 AND kind=$2 AND record_key=$3' +
        ' ORDER BY history_id OFFSET $4 LIMIT 1',
        [this.scopeId, 'trigger_match_history', matchId, maxHistoryRows],
      );
      if (overBudget.rows.length) {
        const error = new Error(
          'Match history exceeds operator scan budget; no revisions compacted',
        );
        error.code = 'EVENT_INTELLIGENCE_MATCH_HISTORY_SCAN_BUDGET_EXCEEDED';
        throw error;
      }
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
        scopeId: this.scopeId, matchId, dryRun, maxHistoryRows, maxScanMs,
        eligible: count, deleted: dryRun ? 0 : count,
        capped: count === maxRows,
      };
    });
    } catch (error) {
      // SQLSTATE 57014 identifies query cancellation even when
      // lc_messages localizes PostgreSQL diagnostics. The operator's own
      // transaction-local timeout was installed for all covered statements;
      // do not key policy semantics on English server message text.
      if (error?.code === '57014') {
        const bounded = new Error(
          'Match-history retention exceeded operator SQL time budget; no history was modified',
        );
        bounded.code = 'EVENT_INTELLIGENCE_MATCH_HISTORY_TIME_BUDGET_EXCEEDED';
        throw bounded;
      }
      throw error;
    }
  }

  // Host-controlled authority epoch, unrelated to provider OAuth.
  // The epoch is deliberately a high-entropy host-generated opaque string,
  // persisted only as a SHA-256 digest, never raw credentials.
  mcpAuthorityInputs(input={}) {
    const {connectionId,epoch}=input??{};
    if(typeof connectionId!=='string'||!connectionId||
       Buffer.byteLength(connectionId,'utf8')>256 ||
       typeof epoch!=='string'||epoch.length<32||epoch.length>256) {
      const error=new Error('MCP session authority requires host connection and epoch');
      error.code='MCP_SESSION_AUTHORITY_INVALID';
      throw error;
    }
    return {connectionId,epochHash:createHash('sha256').update(epoch).digest('hex')};
  }

  async beginMcpConnectionAuthority(input) {
    const {connectionId,epochHash}=this.mcpAuthorityInputs(input);
    return this.tx(async client=>{
      await this.lock(client,'mcp-connection-authority',connectionId);
      const prior=await this.get('mcp_connection_authority',connectionId,client);
      const retiredKey=connectionId+':'+epochHash;
      const retired=await this.get('mcp_connection_retired_epoch',retiredKey,client);
      if(retired) {
        const error=new Error('Retired MCP session epoch cannot be reused');
        error.code='MCP_SESSION_REVOKED';
        throw error;
      }
      if(prior?.epochHash===epochHash && prior?.active!==true) {
        const error=new Error('Revoked MCP session epoch cannot be reused');
        error.code='MCP_SESSION_REVOKED';
        throw error;
      }
      if(prior?.active===true && prior.epochHash!==epochHash) {
        const error=new Error('Host must revoke old connection epoch before replacement');
        error.code='MCP_SESSION_EPOCH_CONFLICT';
        throw error;
      }
      const generation=Number(prior?.generation??0)+
        (prior?.epochHash===epochHash?0:1);
      if(!Number.isSafeInteger(generation)||generation<1) {
        throw new Error('MCP session generation exhausted');
      }
      await this.upsert('mcp_connection_authority',connectionId,{
        connectionId,epochHash,active:true,generation,
      },client);
      return {connectionId,generation,active:true};
    });
  }

  async revokeMcpConnectionAuthority(input) {
    const {connectionId,epochHash}=this.mcpAuthorityInputs(input);
    return this.tx(async client=>{
      await this.lock(client,'mcp-connection-authority',connectionId);
      const prior=await this.get('mcp_connection_authority',connectionId,client);
      // Commit the tombstone under the same advisory lock EVEN IF this
      // epoch is absent or not the current active session. Otherwise a host
      // revocation racing a delayed registration would succeed with false
      // and the later registration could resurrect revoked authority.
      const isCurrent=prior?.epochHash===epochHash && prior?.active===true;
      if(isCurrent) {
        await this.upsert('mcp_connection_authority',connectionId,{
          ...prior,active:false,
        },client);
      }
      // Never revoke a replacement with a different epoch. Tombstone only
      // the requested SHA256 epoch; idempotent historical markers are safe.
      await this.upsert('mcp_connection_retired_epoch',
        connectionId+':'+epochHash,{
          epochHash,connectionId,retired:true,
          generation:isCurrent?prior.generation:null,
        },client);
      return isCurrent;
    });
  }

  async appendMcpOccurrence(serverId, eventInput, subscriptionIdInput = null,
    authority = null) {
    const event = McpEventOccurrenceSchema.parse(eventInput);
    const subscriptionId = subscriptionIdInput == null
      ? null
      : String(subscriptionIdInput);
    const key =
      String(serverId) + ':' + (subscriptionId ?? '') + ':' + event.eventId;
    return this.tx(async (client) => {
      // Shared with operator snapshot: serialize the sequence+history
      // commit including the first INSERT when no counter row exists.
      // Preserve consistent advisory-lock ordering before the key lock.
      await this.lock(client, 'mcp-archive-sequence', 'scope');
      if(this.requireMcpSessionFence || authority!==null) {
        const {connectionId,epochHash}=this.mcpAuthorityInputs(authority);
        await this.lock(client,'mcp-connection-authority',connectionId);
        const current=await this.get('mcp_connection_authority',connectionId,client);
        if(!current||current.active!==true||current.epochHash!==epochHash) {
          const error=new Error('MCP session not authorized for occurrence append');
          error.code='MCP_SESSION_REVOKED';
          throw error;
        }
      }
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

  /**
   * Operator-only, nondestructive bounded snapshot of the occurrence stream.
   * Lock the existing scope-local counter row: competing EI inserts must
   * finish their sequence+history transaction before snapshot enumeration.
   * A 10k upper bound avoids accidental unbounded scans on live systems.
   */
  async getMcpOccurrenceArchiveCheckpoint({ maxOccurrences = 10000, maxScanMs = 5000 } = {}) {
    if (!Number.isSafeInteger(maxOccurrences) ||
        maxOccurrences < 1 || maxOccurrences > 10000 ||
        !Number.isSafeInteger(maxScanMs) ||
        maxScanMs < 100 || maxScanMs > 30000) {
      const error = new TypeError('MCP archive checkpoint requires maxOccurrences 1..10000 and maxScanMs 100..30000');
      error.code = 'EVENT_INTELLIGENCE_MCP_ARCHIVE_POLICY_INVALID';
      throw error;
    }
    try {
      return await this.tx(async client => {
        await client.query("SELECT set_config('statement_timeout', $1, true)",
          [String(maxScanMs) + 'ms']);
        // Lock even before the FIRST occurrence counter row exists. FOR
        // UPDATE alone cannot fence an uncommitted INSERT of that row.
        await this.lock(client, 'mcp-archive-sequence', 'scope');
        const last = await client.query(
          'SELECT value FROM ' + this.counters +
          ' WHERE scope_id=$1 AND name=$2 FOR UPDATE',
          [this.scopeId, 'mcp_occurrence'],
        );
        const endSequence = Number(last.rows[0]?.value ?? 0);
        if (!Number.isSafeInteger(endSequence) || endSequence < 0 ||
            endSequence > maxOccurrences) {
          const error = new Error('MCP occurrence history exceeds bounded archive policy');
          error.code = 'EVENT_INTELLIGENCE_MCP_ARCHIVE_SCAN_BUDGET_EXCEEDED';
          throw error;
        }
        const rows = await client.query(
          // Preserve the original PostgreSQL JSONB numeric lexemes. Parsing
          // to JS numbers before hashing would lose values beyond 2^53.
          'SELECT payload::text AS payload_json FROM ' + this.history +
          ' WHERE scope_id=$1 AND kind=$2 ORDER BY history_id LIMIT $3',
          [this.scopeId, 'mcp_occurrence', maxOccurrences + 1],
        );
        if (rows.rows.length !== endSequence) {
          const error = new Error('MCP archive source history diverged from durable sequence counter');
          error.code = 'EVENT_INTELLIGENCE_MCP_ARCHIVE_INTEGRITY_INVALID';
          throw error;
        }
        let hash = mcpArchiveGenesis(this.scopeId);
        try {
          for (let i = 0; i < rows.rows.length; i++) {
            const raw = rows.rows[i].payload_json;
            if (JSON.parse(raw)?.sequence !== i + 1) {
              throw new Error('sequence gap or reordered record');
            }
            hash = mcpArchiveRecordHash(this.scopeId, hash, raw);
          }
        } catch {
          const error = new Error('MCP archive history sequence or payload invalid');
          error.code = 'EVENT_INTELLIGENCE_MCP_ARCHIVE_INTEGRITY_INVALID';
          throw error;
        }
        return {
          schema: 'event-intelligence.mcp-occurrence-archive.v1',
          scopeId: this.scopeId, genesisHash: mcpArchiveGenesis(this.scopeId),
          endSequence, headHash: hash,
        };
      });
    } catch (error) {
      if (error?.code === '57014') {
        const budget = new Error('MCP archive SQL time budget exceeded');
        budget.code = 'EVENT_INTELLIGENCE_MCP_ARCHIVE_TIME_BUDGET_EXCEEDED';
        throw budget;
      }
      throw error;
    }
  }

  /** Bounded read-only page. Only an EXTERNALLY pinned checkpoint is trusted. */
  async getMcpOccurrenceArchiveWindow({
    checkpoint, afterSequence = 0, previousHash, limit = 100,
    maxScanMs = 5000,
  } = {}) {
    const genesis = mcpArchiveGenesis(this.scopeId);
    const predecessor = previousHash ?? (afterSequence === 0 ? genesis : null);
    if (!checkpoint || checkpoint.schema !== 'event-intelligence.mcp-occurrence-archive.v1' ||
        checkpoint.scopeId !== this.scopeId ||
        !Number.isSafeInteger(checkpoint.endSequence) ||
        checkpoint.endSequence < 0 || checkpoint.endSequence > 10000 ||
        !Number.isSafeInteger(afterSequence) ||
        afterSequence < 0 || afterSequence > checkpoint.endSequence ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 1000 ||
        !Number.isSafeInteger(maxScanMs) || maxScanMs < 100 || maxScanMs > 30000 ||
        typeof predecessor !== 'string' || !/^[0-9a-f]{64}$/.test(predecessor) ||
        checkpoint.genesisHash !== genesis ||
        typeof checkpoint.headHash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(checkpoint.headHash)) {
      const error = new TypeError('MCP archive window requires pinned scope, bounded sequence, hash and page size');
      error.code = 'EVENT_INTELLIGENCE_MCP_ARCHIVE_POLICY_INVALID';
      throw error;
    }
    try {
      return await this.tx(async client => {
        await client.query("SELECT set_config('statement_timeout', $1, true)",
          [String(maxScanMs) + 'ms']);
        const count = Math.min(limit, checkpoint.endSequence - afterSequence);
        const result = await client.query(
          'SELECT payload::text AS payload_json FROM ' + this.history +
          ' WHERE scope_id=$1 AND kind=$2 ORDER BY history_id' +
          ' OFFSET $3 LIMIT $4',
          [this.scopeId, 'mcp_occurrence', afterSequence, count],
        );
        const proof = {
          schema: checkpoint.schema, scopeId: this.scopeId,
          afterSequence, previousHash: predecessor, limit,
          // Raw JSONB text, NOT node-postgres-decoded JSON numbers.
          records: result.rows.map(row => row.payload_json),
          endSequence: afterSequence + result.rows.length,
          headHash: predecessor, hasMore: false,
        };
        try {
          for (const row of proof.records) {
            proof.headHash = mcpArchiveRecordHash(this.scopeId, proof.headHash, row);
          }
        } catch {
          // The independent verifier below must fail closed, not return a
          // success-shaped proof from a malformed historical payload.
        }
        proof.hasMore = proof.endSequence < checkpoint.endSequence;
        if (!verifyMcpOccurrenceArchiveWindow(proof, {
          trustedCheckpoint: checkpoint,
          trustedAfterSequence: afterSequence,
          trustedPreviousHash: predecessor,
          trustedLimit: limit,
        })) {
          const error = new Error('MCP archived occurrence page does not match pinned commitment');
          error.code = 'EVENT_INTELLIGENCE_MCP_ARCHIVE_INTEGRITY_INVALID';
          throw error;
        }
        return proof;
      });
    } catch (error) {
      if (error?.code === '57014') {
        const budget = new Error('MCP archive window SQL time budget exceeded');
        budget.code = 'EVENT_INTELLIGENCE_MCP_ARCHIVE_TIME_BUDGET_EXCEEDED';
        throw budget;
      }
      throw error;
    }
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
    // Retention safety fence: a missing historical occurrence or durable
    // dedup key must NEVER masquerade as a successful (partial) replay.
    // No source pruning is enabled today. Until a verified archive-backed
    // replay floor exists, *every* source record remains mandatory.
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      const error = new TypeError('MCP replay cursor must be a nonnegative safe sequence');
      error.code = 'EVENT_INTELLIGENCE_MCP_REPLAY_CURSOR_INVALID';
      throw error;
    }
    return this.tx(async client => {
      // All source writer state (counter + dedup + history) commits in
      // ONE PostgreSQL transaction. A read-only REPEATABLE READ snapshot
      // sees either all or none of a concurrent append, even the first.
      // Crucially, a frequently polling reader does NOT hold the writer's
      // advisory lock over potentially large historical scans.
      await client.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
      );
      const c = await client.query(
        'SELECT value FROM ' + this.counters +
        ' WHERE scope_id=$1 AND name=$2',
        [this.scopeId, 'mcp_occurrence'],
      );
      const endSequence = Number(c.rows[0]?.value ?? 0);
      if (!Number.isSafeInteger(endSequence) || endSequence < 0 ||
          sequence > endSequence) {
        const error = new Error('MCP replay sequence is beyond the durable source tail');
        error.code = 'EVENT_INTELLIGENCE_MCP_REPLAY_CURSOR_INVALID';
        throw error;
      }
      const history = await client.query(
        'SELECT payload::text AS payload_json FROM ' + this.history +
        ' WHERE scope_id=$1 AND kind=$2 ORDER BY history_id',
        [this.scopeId, 'mcp_occurrence'],
      );
      const dedup = await client.query(
        'SELECT record_key,payload::text AS payload_json FROM ' + this.records +
        ' WHERE scope_id=$1 AND kind=$2',
        [this.scopeId, 'mcp_occurrence_key'],
      );
      const keys = new Map(dedup.rows.map(row=>[row.record_key,row.payload_json]));
      const results = [];
      let expected = 1;
      const invalid = ()=>{
        const error = new Error(
          'MCP replay history or dedup retention is incomplete; refuse silent replay',
        );
        error.code = 'EVENT_INTELLIGENCE_MCP_REPLAY_HISTORY_GAP';
        return error;
      };
      for (const {payload_json:rawPayload} of history.rows) {
        let record;
        try {
          // The provenance comparison uses lossless PG JSONB::text, but
          // returning a JS Number could STILL silently round a genuine
          // provider integer/decimal even when history and dedup match.
          // Until there is a precision-aware event data representation,
          // refuse to dispatch a corrupted success-shaped replay.
          assertAuditJsonNumberPrecision(rawPayload);
          record=JSON.parse(rawPayload);
        } catch { throw invalid(); }
        if (!Number.isSafeInteger(record?.sequence) ||
            record.sequence !== expected ||
            typeof record.serverId !== 'string' ||
            !(record.subscriptionId === null ||
              typeof record.subscriptionId === 'string') ||
            !McpEventOccurrenceSchema.safeParse(record.event).success) {
          throw invalid();
        }
        const key = record.serverId+':'+(record.subscriptionId??'')+
          ':'+record.event.eventId;
        const originalDedupJson = keys.get(key);
        // PostgreSQL JSONB::text preserves numeric lexemes beyond JS 2^53.
        // Full canonical raw-object equality also detects changed event
        // payloads, metadata, extra fields and omitted source properties.
        if (typeof originalDedupJson !== 'string' ||
            originalDedupJson !== rawPayload) {
          throw invalid();
        }
        keys.delete(key);
        if (record.sequence > sequence) {
          results.push({
            sequence:record.sequence,serverId:record.serverId,
            subscriptionId:record.subscriptionId,
            event:{...record.event,data:{...record.event.data}},
          });
        }
        expected++;
      }
      if (expected !== endSequence + 1 || keys.size) throw invalid();
      return results;
    });
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
    if (Buffer.byteLength(key,'utf8') > MCP_STATE_KEY_MAX_BYTES) {
      const error = new Error('MCP provider source identity exceeds persisted key byte limit');
      error.code = 'EVENT_INTELLIGENCE_MCP_CLIENT_STATE_SIZE_LIMIT';
      throw error;
    }
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
      const encodedState=JSON.stringify(state);
      // Fast precheck; the definitive guard below counts PostgreSQL JSONB's
      // own logical textual representation, including normalized spaces.
      if (Buffer.byteLength(encodedState,'utf8') >
          MCP_STATE_PAYLOAD_MAX_BYTES) {
        const error = new Error('MCP provider client state exceeds persisted JSONB byte limit');
        error.code = 'EVENT_INTELLIGENCE_MCP_CLIENT_STATE_SIZE_LIMIT';
        throw error;
      }
      const renderedSize=await client.query(
        'SELECT octet_length($1::jsonb::text)::int AS logical_bytes',
        [encodedState],
      );
      if (renderedSize.rows[0]?.logical_bytes >
          MCP_STATE_PAYLOAD_MAX_BYTES) {
        const error = new Error('MCP provider PostgreSQL canonical JSONB exceeds persisted byte limit');
        error.code = 'EVENT_INTELLIGENCE_MCP_CLIENT_STATE_SIZE_LIMIT';
        throw error;
      }
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

  /** Return at most limit rows in an explicit scope/match window. */
  async inspectionWindow(kind, matchId, {limit=50,maxScanMs=2000,maxRowBytes=16384}={}) {
    if (!['derived_event','temporal_deadline'].includes(kind) ||
        typeof matchId !== 'string' || !matchId ||
        !Number.isSafeInteger(limit) || limit<1 || limit>100 ||
        !Number.isSafeInteger(maxScanMs) || maxScanMs<100 || maxScanMs>5000 ||
        !Number.isSafeInteger(maxRowBytes) || maxRowBytes<1024 || maxRowBytes>32768) {
      throw new RangeError('Invalid bounded inspection window');
    }
    try {
      return await this.tx(async client=>{
        await client.query("SELECT set_config('statement_timeout',$1,true)",
          [String(maxScanMs)+'ms']);
        const result=await client.query(
          'SELECT CASE WHEN octet_length(payload::text)<=$5 THEN payload ELSE NULL END AS payload' +
          ' FROM '+this.records+
          " WHERE scope_id=$1 AND kind=$2 AND payload->>'matchId'=$3" +
          ' ORDER BY record_key LIMIT $4',
          [this.scopeId,kind,matchId,limit+1,maxRowBytes],
        );
        if(result.rows.some(row=>row.payload===null)){
          const error=new Error('Inspection persisted row exceeds byte budget');
          error.code='EVENT_INTELLIGENCE_INSPECTION_BUDGET_EXCEEDED';
          throw error;
        }
        return {records:result.rows.slice(0,limit).map(row=>row.payload),
          hasMore:result.rows.length>limit,limit};
      });
    } catch(error) {
      if(error?.code==='57014'){
        const refused=new Error('Inspection database scan exceeded time budget');
        refused.code='EVENT_INTELLIGENCE_INSPECTION_BUDGET_EXCEEDED';
        throw refused;
      }
      throw error;
    }
  }

  async getBoundedInspectionDeadlines(matchId,opts) {
    return this.inspectionWindow('temporal_deadline',matchId,opts);
  }

  async getBoundedInspectionDerivedEvents(matchId,opts) {
    return this.inspectionWindow('derived_event',matchId,opts);
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
      // pg's JSONB parser would round numbers beyond IEEE-754 precision
      // before canonical AuditChain hashing, letting two different stored
      // byte sequences produce the same digest. Reject lossy lexemes first.
      const source = await client.query(
        'SELECT payload::text AS raw FROM ' + this.history +
        ' WHERE scope_id=$1 AND kind=$2 ORDER BY history_id ASC',
        [this.scopeId, 'audit'],
      );
      const records = source.rows.map(({raw}) => {
        assertAuditJsonNumberPrecision(raw);
        const value=JSON.parse(raw);
        const record=parseAuditRecord(value);
        if(!isDeepStrictEqual(value,record)) {
          const error=new Error('Uncommitted audit record fields prevent checkpoint');
          error.code='EVENT_INTELLIGENCE_AUDIT_UNCOMMITTED_FIELDS';
          throw error;
        }
        return record;
      });
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
      const parseSafeAuditJson = raw => {
        assertAuditJsonNumberPrecision(raw);
        const value=JSON.parse(raw);
        const record=parseAuditRecord(value);
        if(!isDeepStrictEqual(value,record)) {
          const error=new Error('Uncommitted audit fields in proof page');
          error.code='EVENT_INTELLIGENCE_AUDIT_UNCOMMITTED_FIELDS';
          throw error;
        }
        return record;
      };
      let terminalHistoryId = null;
      if (checkpoint.endSequence >= 0) {
        const first = await client.query(
          'SELECT payload::text AS raw FROM ' + this.history +
          ' WHERE scope_id=$1 AND kind=$2 ORDER BY history_id ASC LIMIT 1',
          [this.scopeId, 'audit'],
        );
        const terminal = await client.query(
          'SELECT history_id, payload::text AS raw FROM ' + this.history +
          ' WHERE scope_id=$1 AND kind=$2' +
          " AND (payload->>'sequence')::bigint=$3" +
          ' ORDER BY history_id ASC LIMIT 1',
          [this.scopeId, 'audit', checkpoint.endSequence],
        );
        if (!first.rows.length || !terminal.rows.length ||
            parseSafeAuditJson(first.rows[0].raw).hash !== checkpoint.firstHash ||
            parseSafeAuditJson(terminal.rows[0].raw).hash !== checkpoint.headHash) {
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
          'SELECT history_id, payload::text AS raw FROM ' + this.history +
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
        previousHash = parseSafeAuditJson(prev.rows[0].raw).hash;
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
          'SELECT payload::text AS raw FROM ' + this.history +
          ' WHERE ' + conditions.join(' AND ') +
          ' ORDER BY history_id ASC LIMIT ' +
          (previousHistoryId === null ? '$4' : '$5'),
          args,
        );
        records = rows.rows.slice(0, limit).map(row =>
          parseSafeAuditJson(row.raw)
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
