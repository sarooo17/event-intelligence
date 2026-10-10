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
  DEFAULT_EVENT_SCOPE_ID,
  normalizeEventScopeId,
} from './persistent-event-store.mjs';

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
    JSON.stringify(canonical(args ?? {}));
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
    this.tablePrefix = ident(tablePrefix, 'tablePrefix');
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
      });
      this.initialized = true;
    }
    return this.restoredCounts();
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

  getWakeDelivery(wakeId) {
    return this.get('wake_delivery', wakeId);
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
    const definition = parseCompositeTriggerDefinition(input);
    const key = definition.triggerId + '@' + definition.version;
    if (!await this.insert('trigger', key, definition)) {
      const error = new Error('Trigger ' + key + ' already exists');
      error.code = 'TRIGGER_ALREADY_EXISTS';
      throw error;
    }
    return definition;
  }

  async listTriggers() {
    return (await this.list('trigger')).map(parseCompositeTriggerDefinition);
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
      await this.lock(client, 'trigger-state', key);
      const previous = await this.get('trigger_state', key, client) ??
        defaultTriggerState(triggerId, version);
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
    const args =
      input.arguments && !Array.isArray(input.arguments) &&
      typeof input.arguments === 'object'
        ? input.arguments
        : {};
    const key = mcpStateKey(connectionId, eventName, args);
    return this.tx(async (client) => {
      await this.lock(client, 'mcp-client-state', key);
      const previous = await this.get('mcp_client_state', key, client);
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
        ...(input.nextPollAt || previous?.nextPollAt
          ? { nextPollAt: String(input.nextPollAt || previous.nextPollAt) }
          : {}),
        ...(input.lastEventAt || previous?.lastEventAt
          ? { lastEventAt: String(input.lastEventAt || previous.lastEventAt) }
          : {}),
        ...(input.lastError ? { lastError: String(input.lastError) } : {}),
        ...(typeof input.truncated === 'boolean'
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

  async compactMutableState() {
    return { ok: true, strategy: 'database-managed', compacted: [] };
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
