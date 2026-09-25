import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  AuditChain,
  parseAuditRecord,
  parseCompositeTriggerDefinition,
  parseTriggerMatchRecord,
  parseDerivedEventRecord,
  McpEventOccurrenceSchema,
} from '../../dist/src/intelligenceProtocol/index.js';

export const DEFAULT_EVENT_SCOPE_ID = 'default';

export function normalizeEventScopeId(input = DEFAULT_EVENT_SCOPE_ID) {
  const scopeId = String(input ?? DEFAULT_EVENT_SCOPE_ID).trim();
  if (!scopeId) throw new Error('Event Intelligence scopeId must not be empty');
  if (scopeId.length > 240) {
    throw new Error('Event Intelligence scopeId must be at most 240 characters');
  }
  return scopeId;
}

function scopeDirectoryName(scopeId) {
  return Buffer.from(scopeId, 'utf8').toString('base64url');
}

function scopeIdFromDirectoryName(name) {
  try {
    return Buffer.from(name, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function canonicalStateValue(value) {
  if (Array.isArray(value)) return value.map(canonicalStateValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalStateValue(value[key])]),
    );
  }
  return value;
}

function mcpClientStateKey(connectionId, eventName, args = {}) {
  return `${String(connectionId)}::${String(eventName)}::${JSON.stringify(canonicalStateValue(args ?? {}))}`;
}

async function readJsonLines(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export class PersistentEventStore {
  #queue = Promise.resolve();
  #eventKeys = new Set();
  #events = [];
  #decisions = [];
  #wakes = [];
  #wakeDeliveries = new Map();
  #triggers = new Map();
  #triggerStates = new Map();
  #eventSources = new Map();
  #triggerMatchHistory = [];
  #triggerMatches = new Map();
  #mcpOccurrences = [];
  #mcpOccurrenceKeys = new Set();
  #mcpClientStates = new Map();
  #temporalDeadlines = new Map();
  #derivedEvents = new Map();
  #derivedContracts = new Map();
  #auditChain = new AuditChain();
  #scopeStores = new Map();

  constructor(dataDir) {
    this.dataDir = dataDir;
    this.files = {
      events: path.join(dataDir, 'events.jsonl'),
      decisions: path.join(dataDir, 'decisions.jsonl'),
      wakes: path.join(dataDir, 'wakes.jsonl'),
      wakeDeliveries: path.join(dataDir, 'wake-deliveries.jsonl'),
      triggers: path.join(dataDir, 'triggers.jsonl'),
      triggerStates: path.join(dataDir, 'trigger-states.jsonl'),
      eventSources: path.join(dataDir, 'event-sources.jsonl'),
      triggerMatches: path.join(dataDir, 'trigger-matches.jsonl'),
      mcpOccurrences: path.join(dataDir, 'mcp-events.jsonl'),
      mcpClientStates: path.join(dataDir, 'mcp-client-states.jsonl'),
      temporalDeadlines: path.join(dataDir, 'temporal-deadlines.jsonl'),
      derivedEvents: path.join(dataDir, 'derived-events.jsonl'),
      derivedContracts: path.join(dataDir, 'derived-contracts.jsonl'),
      audit: path.join(dataDir, 'audit.jsonl'),
    };
  }

  async forScope(scopeIdInput = DEFAULT_EVENT_SCOPE_ID) {
    const scopeId = normalizeEventScopeId(scopeIdInput);
    if (scopeId === DEFAULT_EVENT_SCOPE_ID) return this;

    const existing = this.#scopeStores.get(scopeId);
    if (existing) return existing;

    const scoped = new PersistentEventStore(
      path.join(this.dataDir, 'scopes', scopeDirectoryName(scopeId)),
    );
    await scoped.init();
    this.#scopeStores.set(scopeId, scoped);
    return scoped;
  }

  async listScopeIds() {
    const scopes = new Set([
      DEFAULT_EVENT_SCOPE_ID,
      ...this.#scopeStores.keys(),
    ]);
    try {
      const entries = await readdir(path.join(this.dataDir, 'scopes'), {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const scopeId = scopeIdFromDirectoryName(entry.name);
        if (scopeId) scopes.add(scopeId);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return [...scopes].sort();
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });

    const [
      events,
      decisions,
      wakes,
      wakeDeliveries,
      triggers,
      triggerStates,
      eventSources,
      triggerMatches,
      mcpOccurrences,
      mcpClientStates,
      temporalDeadlines,
      derivedEvents,
      derivedContracts,
      audit,
    ] = await Promise.all([
      readJsonLines(this.files.events),
      readJsonLines(this.files.decisions),
      readJsonLines(this.files.wakes),
      readJsonLines(this.files.wakeDeliveries),
      readJsonLines(this.files.triggers),
      readJsonLines(this.files.triggerStates),
      readJsonLines(this.files.eventSources),
      readJsonLines(this.files.triggerMatches),
      readJsonLines(this.files.mcpOccurrences),
      readJsonLines(this.files.mcpClientStates),
      readJsonLines(this.files.temporalDeadlines),
      readJsonLines(this.files.derivedEvents),
      readJsonLines(this.files.derivedContracts),
      readJsonLines(this.files.audit),
    ]);

    this.#events = events;
    this.#decisions = decisions;
    this.#wakes = wakes;

    this.#wakeDeliveries = new Map();
    for (const raw of wakeDeliveries) {
      if (!raw?.wakeId || !raw?.runtime || (!raw?.sourceId && !raw?.matchId)) continue;
      const status = [
        'pending',
        'claimed',
        'retry_pending',
        'delivered',
        'dead_letter',
      ].includes(raw.status)
        ? raw.status
        : 'pending';
      const record = {
        wakeId: String(raw.wakeId),
        sourceType: raw.sourceType === 'event' ? 'event' : 'composite',
        sourceId: String(raw.sourceId || raw.matchId),
        matchId: raw.matchId ? String(raw.matchId) : '',
        triggerId: String(raw.triggerId || ''),
        triggerVersion: String(raw.triggerVersion || '1'),
        runtime: String(raw.runtime),
        status,
        attemptCount:
          Number.isInteger(raw.attemptCount) && raw.attemptCount >= 0
            ? raw.attemptCount
            : 0,
        nextAttemptAt: String(raw.nextAttemptAt || raw.updatedAt || new Date(0).toISOString()),
        leaseOwner: raw.leaseOwner ? String(raw.leaseOwner) : null,
        leaseUntil: raw.leaseUntil ? String(raw.leaseUntil) : null,
        runtimeReceiptId: raw.runtimeReceiptId ? String(raw.runtimeReceiptId) : null,
        lastError: raw.lastError ? String(raw.lastError) : null,
        createdAt: String(raw.createdAt || new Date(0).toISOString()),
        updatedAt: String(raw.updatedAt || new Date(0).toISOString()),
      };
      this.#wakeDeliveries.set(record.wakeId, record);
    }

    this.#triggers = new Map();
    for (const raw of triggers) {
      const definition = parseCompositeTriggerDefinition(raw);
      this.#triggers.set(this.#triggerKey(definition), definition);
    }

    this.#triggerStates = new Map();
    for (const raw of triggerStates) {
      if (!raw?.triggerId || !raw?.version) continue;
      this.#triggerStates.set(
        `${raw.triggerId}@${raw.version}`,
        {
          triggerId: String(raw.triggerId),
          version: String(raw.version),
          status: ['active', 'paused', 'completed', 'expired', 'deleted'].includes(raw.status)
            ? raw.status
            : 'active',
          updatedAt: String(raw.updatedAt || new Date(0).toISOString()),
          actor: raw.actor ?? null,
          owner: raw.owner ?? null,
          connectionIds: Array.isArray(raw.connectionIds)
            ? raw.connectionIds.map(String)
            : [],
          fireCount: Number.isInteger(raw.fireCount) && raw.fireCount >= 0
            ? raw.fireCount
            : 0,
          lastFiredAt: raw.lastFiredAt ? String(raw.lastFiredAt) : null,
          revision: Number.isInteger(raw.revision) && raw.revision >= 0
            ? raw.revision
            : 0,
        },
      );
    }

    this.#eventSources = new Map();
    for (const raw of eventSources) {
      if (!raw?.sourceId || !raw?.eventName || !raw?.connectionId) continue;
      this.#eventSources.set(String(raw.sourceId), {
        sourceId: String(raw.sourceId),
        connectionId: String(raw.connectionId),
        serverId: String(raw.serverId || raw.connectionId),
        eventName: String(raw.eventName),
        description: raw.description ? String(raw.description) : undefined,
        delivery: Array.isArray(raw.delivery) ? raw.delivery.map(String) : ['webhook'],
        inputSchema: raw.inputSchema && typeof raw.inputSchema === 'object' ? raw.inputSchema : undefined,
        payloadSchema: raw.payloadSchema && typeof raw.payloadSchema === 'object' ? raw.payloadSchema : undefined,
        enabled: raw.enabled !== false,
        experimental: raw.experimental !== false,
        metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : undefined,
        updatedAt: String(raw.updatedAt || new Date(0).toISOString()),
      });
    }

    this.#triggerMatchHistory = [];
    this.#triggerMatches = new Map();
    for (const raw of triggerMatches) {
      const record = parseTriggerMatchRecord(raw);
      this.#triggerMatchHistory.push(record);
      this.#triggerMatches.set(record.matchId, record);
    }

    this.#mcpOccurrences = [];
    this.#mcpOccurrenceKeys = new Set();
    for (const raw of mcpOccurrences) {
      const record = {
        sequence: Number(raw.sequence),
        serverId: String(raw.serverId),
        event: McpEventOccurrenceSchema.parse(raw.event),
      };
      if (!Number.isInteger(record.sequence) || record.sequence < 1) {
        throw new Error('Invalid persisted MCP event sequence');
      }
      this.#mcpOccurrences.push(record);
      this.#mcpOccurrenceKeys.add(
        `${record.serverId}:${record.event.eventId}`,
      );
    }
    this.#mcpOccurrences.sort((a, b) => a.sequence - b.sequence);

    this.#mcpClientStates = new Map();
    for (const raw of mcpClientStates) {
      if (!raw?.connectionId || !raw?.eventName) continue;
      const state = {
        connectionId: String(raw.connectionId),
        serverId: String(raw.serverId || raw.connectionId),
        eventName: String(raw.eventName),
        arguments:
          raw.arguments && !Array.isArray(raw.arguments) && typeof raw.arguments === 'object'
            ? raw.arguments
            : {},
        subscriptionId: raw.subscriptionId ? String(raw.subscriptionId) : null,
        deliveryMode: raw.deliveryMode ? String(raw.deliveryMode) : 'poll',
        cursor: raw.cursor === null || raw.cursor === undefined
          ? null
          : String(raw.cursor),
        updatedAt: String(raw.updatedAt || new Date(0).toISOString()),
        ...(raw.nextPollAt ? { nextPollAt: String(raw.nextPollAt) } : {}),
        ...(raw.lastEventAt ? { lastEventAt: String(raw.lastEventAt) } : {}),
        ...(raw.lastError ? { lastError: String(raw.lastError) } : {}),
        ...(typeof raw.truncated === 'boolean' ? { truncated: raw.truncated } : {}),
      };
      this.#mcpClientStates.set(
        mcpClientStateKey(
          state.connectionId,
          state.eventName,
          state.arguments,
        ),
        state,
      );
    }

    this.#temporalDeadlines = new Map();
    for (const raw of temporalDeadlines) {
      if (!raw?.deadlineId || !raw?.triggerId || !raw?.matchId || !raw?.conditionId) {
        continue;
      }
      const deadline = {
        deadlineId: String(raw.deadlineId),
        triggerId: String(raw.triggerId),
        triggerVersion: String(raw.triggerVersion || '1'),
        matchId: String(raw.matchId),
        conditionId: String(raw.conditionId),
        dueAt: String(raw.dueAt),
        status: ['pending', 'cancelled', 'fired'].includes(raw.status)
          ? raw.status
          : 'pending',
        createdAt: String(raw.createdAt || new Date(0).toISOString()),
        updatedAt: String(raw.updatedAt || new Date(0).toISOString()),
      };
      this.#temporalDeadlines.set(deadline.deadlineId, deadline);
    }

    this.#derivedEvents = new Map();
    for (const raw of derivedEvents) {
      const record = parseDerivedEventRecord(raw);
      this.#derivedEvents.set(
        `${record.event.serverId ?? ''}::${record.event.sourceEventId}`,
        record,
      );
    }

    this.#derivedContracts = new Map();
    for (const raw of derivedContracts) {
      if (!raw?.eventName || !raw?.contractVersion || !raw?.schemaFingerprint) continue;
      const record = {
        eventName: String(raw.eventName),
        contractVersion: String(raw.contractVersion),
        payloadSchema: raw.payloadSchema && typeof raw.payloadSchema === 'object'
          ? raw.payloadSchema
          : {},
        schemaFingerprint: String(raw.schemaFingerprint),
        producers: Array.isArray(raw.producers)
          ? raw.producers.map((producer) => ({
              triggerId: String(producer.triggerId),
              triggerVersion: String(producer.triggerVersion),
            }))
          : [],
        createdAt: String(raw.createdAt || new Date(0).toISOString()),
        updatedAt: String(raw.updatedAt || new Date(0).toISOString()),
      };
      this.#derivedContracts.set(
        `${record.eventName}@${record.contractVersion}`,
        record,
      );
    }

    this.#auditChain = new AuditChain(audit.map(parseAuditRecord));

    for (const record of events) {
      this.#eventKeys.add(this.#eventKey(record.lineage));
    }

    if (!(await this.#auditChain.verify())) {
      throw new Error('Persistent audit chain verification failed');
    }

    return {
      events: events.length,
      decisions: decisions.length,
      wakes: wakes.length,
      wakeDeliveries: this.#wakeDeliveries.size,
      triggers: this.#triggers.size,
      triggerStates: this.#triggerStates.size,
      eventSources: this.#eventSources.size,
      triggerMatches: this.#triggerMatches.size,
      triggerMatchRevisions: this.#triggerMatchHistory.length,
      mcpOccurrences: this.#mcpOccurrences.length,
      mcpClientStates: this.#mcpClientStates.size,
      temporalDeadlines: this.#temporalDeadlines.size,
      derivedEvents: this.#derivedEvents.size,
      derivedContracts: this.#derivedContracts.size,
      audit: audit.length,
    };
  }

  async registerEvent(record) {
    return this.#serialized(async () => {
      const key = this.#eventKey(record.lineage);
      if (this.#eventKeys.has(key)) return false;

      this.#eventKeys.add(key);
      this.#events.push(record);
      await appendFile(this.files.events, `${JSON.stringify(record)}\n`, 'utf8');
      return true;
    });
  }

  async appendDecision(record) {
    return this.#serialized(async () => {
      this.#decisions.push(record);
      await appendFile(this.files.decisions, `${JSON.stringify(record)}\n`, 'utf8');
      return record;
    });
  }

  async appendWake(record) {
    return this.#serialized(async () => {
      this.#wakes.push(record);
      await appendFile(this.files.wakes, `${JSON.stringify(record)}\n`, 'utf8');
      return record;
    });
  }

  getWakeDelivery(wakeId) {
    return this.#wakeDeliveries.get(String(wakeId)) ?? null;
  }

  listDueWakeDeliveries(nowIso = new Date().toISOString()) {
    const now = Date.parse(nowIso);
    return [...this.#wakeDeliveries.values()]
      .filter((record) => {
        if (record.status === 'pending' || record.status === 'retry_pending') {
          return Date.parse(record.nextAttemptAt) <= now;
        }
        if (record.status === 'claimed' && record.leaseUntil) {
          return Date.parse(record.leaseUntil) <= now;
        }
        if (record.status === 'delivered') {
          const latestWake = this.latestWake(record.wakeId);
          const wakeFinalized =
            latestWake?.status === 'delivered' ||
            latestWake?.status === 'handled';
          if (record.sourceType === 'event') {
            return !wakeFinalized;
          }
          const match = this.#triggerMatches.get(record.matchId);
          return !wakeFinalized || match?.status !== 'fired';
        }
        return false;
      })
      .sort((a, b) =>
        Date.parse(a.nextAttemptAt) - Date.parse(b.nextAttemptAt) ||
        a.wakeId.localeCompare(b.wakeId)
      );
  }

  async ensureWakeDelivery(input) {
    return this.#serialized(async () => {
      const wakeId = String(input.wakeId || '');
      const sourceType = input.sourceType === 'event' ? 'event' : 'composite';
      const matchId = String(input.matchId || '');
      const sourceId = String(input.sourceId || matchId || '');
      const runtime = String(input.runtime || '');
      if (!wakeId || !sourceId || !runtime) {
        throw new Error('Wake delivery requires wakeId, sourceId and runtime');
      }
      if (sourceType === 'composite' && !matchId) {
        throw new Error('Composite wake delivery requires matchId');
      }
      const existing = this.#wakeDeliveries.get(wakeId);
      if (existing) return existing;

      const now = String(input.now ?? new Date().toISOString());
      const record = {
        wakeId,
        sourceType,
        sourceId,
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
      this.#wakeDeliveries.set(wakeId, record);
      await appendFile(
        this.files.wakeDeliveries,
        `${JSON.stringify(record)}\n`,
        'utf8',
      );
      return record;
    });
  }

  async claimWakeDelivery(wakeIdInput, {
    workerId,
    now = new Date().toISOString(),
    leaseMs = 30000,
  } = {}) {
    return this.#serialized(async () => {
      const wakeId = String(wakeIdInput || '');
      const owner = String(workerId || '');
      if (!wakeId || !owner) {
        throw new Error('Wake delivery claim requires wakeId and workerId');
      }
      const current = this.#wakeDeliveries.get(wakeId);
      if (!current) return null;
      if (current.status === 'delivered' || current.status === 'dead_letter') {
        return null;
      }

      const nowMs = Date.parse(now);
      const ready =
        (
          (current.status === 'pending' || current.status === 'retry_pending') &&
          Date.parse(current.nextAttemptAt) <= nowMs
        ) ||
        (
          current.status === 'claimed' &&
          current.leaseUntil &&
          Date.parse(current.leaseUntil) <= nowMs
        );
      if (!ready) return null;

      const record = {
        ...current,
        status: 'claimed',
        attemptCount: current.attemptCount + 1,
        leaseOwner: owner,
        leaseUntil: new Date(nowMs + Math.max(1000, Number(leaseMs) || 30000)).toISOString(),
        updatedAt: now,
      };
      this.#wakeDeliveries.set(wakeId, record);
      await appendFile(
        this.files.wakeDeliveries,
        `${JSON.stringify(record)}\n`,
        'utf8',
      );
      return record;
    });
  }

  async completeWakeDelivery(wakeIdInput, {
    workerId,
    runtimeReceiptId,
    now = new Date().toISOString(),
  } = {}) {
    return this.#serialized(async () => {
      const wakeId = String(wakeIdInput || '');
      const current = this.#wakeDeliveries.get(wakeId);
      if (!current) return null;
      if (current.status === 'delivered') return current;
      if (
        current.status !== 'claimed' ||
        current.leaseOwner !== String(workerId || '')
      ) {
        const error = new Error(`Wake delivery ${wakeId} is not owned by this worker`);
        error.code = 'WAKE_DELIVERY_CLAIM_LOST';
        throw error;
      }

      const record = {
        ...current,
        status: 'delivered',
        runtimeReceiptId: String(runtimeReceiptId || ''),
        leaseOwner: null,
        leaseUntil: null,
        nextAttemptAt: now,
        lastError: null,
        updatedAt: now,
      };
      this.#wakeDeliveries.set(wakeId, record);
      await appendFile(
        this.files.wakeDeliveries,
        `${JSON.stringify(record)}\n`,
        'utf8',
      );
      return record;
    });
  }

  async failWakeDelivery(wakeIdInput, {
    workerId,
    error,
    now = new Date().toISOString(),
    maxAttempts = 5,
    nextAttemptAt = now,
  } = {}) {
    return this.#serialized(async () => {
      const wakeId = String(wakeIdInput || '');
      const current = this.#wakeDeliveries.get(wakeId);
      if (!current) return null;
      if (
        current.status !== 'claimed' ||
        current.leaseOwner !== String(workerId || '')
      ) {
        const claimError = new Error(
          `Wake delivery ${wakeId} is not owned by this worker`,
        );
        claimError.code = 'WAKE_DELIVERY_CLAIM_LOST';
        throw claimError;
      }

      const terminal = current.attemptCount >= Math.max(1, Number(maxAttempts) || 5);
      const record = {
        ...current,
        status: terminal ? 'dead_letter' : 'retry_pending',
        leaseOwner: null,
        leaseUntil: null,
        nextAttemptAt: terminal ? now : String(nextAttemptAt),
        lastError: error instanceof Error ? error.message : String(error || 'wake delivery failed'),
        updatedAt: now,
      };
      this.#wakeDeliveries.set(wakeId, record);
      await appendFile(
        this.files.wakeDeliveries,
        `${JSON.stringify(record)}\n`,
        'utf8',
      );
      return record;
    });
  }

  async putTrigger(definitionInput) {
    return this.#serialized(async () => {
      const definition = parseCompositeTriggerDefinition(definitionInput);
      const key = this.#triggerKey(definition);
      if (this.#triggers.has(key)) {
        const error = new Error(
          `Trigger ${definition.triggerId}@${definition.version} already exists`,
        );
        error.code = 'TRIGGER_ALREADY_EXISTS';
        throw error;
      }
      this.#triggers.set(key, definition);
      await appendFile(
        this.files.triggers,
        `${JSON.stringify(definition)}\n`,
        'utf8',
      );
      return definition;
    });
  }

  listTriggers() {
    return [...this.#triggers.values()];
  }

  getTriggerState(triggerId, version) {
    return this.#triggerStates.get(`${triggerId}@${version}`) ?? {
      triggerId,
      version,
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

  async setTriggerState(
    triggerId,
    version,
    status,
    actor = null,
    metadata = {},
  ) {
    return this.#serialized(async () => {
      const key = `${triggerId}@${version}`;
      const previous = this.#triggerStates.get(key);
      const allowedStatuses = new Set([
        'active',
        'paused',
        'completed',
        'expired',
        'deleted',
      ]);
      if (!allowedStatuses.has(status)) {
        throw new Error(`Invalid trigger lifecycle status: ${status}`);
      }
      const next = {
        triggerId: String(triggerId),
        version: String(version),
        status,
        updatedAt: new Date().toISOString(),
        actor,
        owner: metadata.owner ?? previous?.owner ?? null,
        connectionIds: Array.isArray(metadata.connectionIds)
          ? metadata.connectionIds.map(String)
          : previous?.connectionIds ?? [],
        fireCount: Number.isInteger(metadata.fireCount)
          ? metadata.fireCount
          : previous?.fireCount ?? 0,
        lastFiredAt: metadata.lastFiredAt !== undefined
          ? metadata.lastFiredAt
          : previous?.lastFiredAt ?? null,
        revision: (previous?.revision ?? 0) + 1,
      };
      this.#triggerStates.set(`${next.triggerId}@${next.version}`, next);
      await appendFile(
        this.files.triggerStates,
        `${JSON.stringify(next)}\n`,
        'utf8',
      );
      return next;
    });
  }

  listTriggerStates() {
    return [...this.#triggerStates.values()];
  }

  async putEventSource(input) {
    return this.#serialized(async () => {
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
      this.#eventSources.set(source.sourceId, source);
      await appendFile(
        this.files.eventSources,
        `${JSON.stringify(source)}\n`,
        'utf8',
      );
      return source;
    });
  }

  listEventSources({ connectionIds, enabledOnly = false } = {}) {
    const ids = Array.isArray(connectionIds) && connectionIds.length
      ? new Set(connectionIds.map(String))
      : null;
    return [...this.#eventSources.values()]
      .filter((source) => !ids || ids.has(source.connectionId))
      .filter((source) => !enabledOnly || source.enabled !== false);
  }

  async appendTriggerMatch(recordInput) {
    return this.#serialized(async () => {
      const record = parseTriggerMatchRecord(recordInput);
      this.#triggerMatchHistory.push(record);
      this.#triggerMatches.set(record.matchId, record);
      await appendFile(
        this.files.triggerMatches,
        `${JSON.stringify(record)}\n`,
        'utf8',
      );
      return record;
    });
  }

  listTriggerMatches(triggerId) {
    return [...this.#triggerMatches.values()]
      .filter((record) => !triggerId || record.triggerId === triggerId);
  }

  listTriggerMatchHistory(matchId) {
    return this.#triggerMatchHistory
      .filter((record) => !matchId || record.matchId === matchId);
  }

  async appendMcpOccurrence(serverId, eventInput) {
    return this.#serialized(async () => {
      const event = McpEventOccurrenceSchema.parse(eventInput);
      const key = `${serverId}:${event.eventId}`;
      const existing = this.#mcpOccurrences.find(
        (record) =>
          record.serverId === serverId &&
          record.event.eventId === event.eventId,
      );
      if (this.#mcpOccurrenceKeys.has(key)) {
        return {
          accepted: false,
          sequence: existing?.sequence ?? null,
          event: existing?.event ?? event,
        };
      }

      const sequence = this.latestMcpEventSequence() + 1;
      const record = { sequence, serverId, event };
      this.#mcpOccurrenceKeys.add(key);
      this.#mcpOccurrences.push(record);
      await appendFile(
        this.files.mcpOccurrences,
        `${JSON.stringify(record)}\n`,
        'utf8',
      );
      return { accepted: true, sequence, event };
    });
  }

  latestMcpEventSequence() {
    return this.#mcpOccurrences.at(-1)?.sequence ?? 0;
  }

  listMcpOccurrencesAfter(sequence) {
    return this.#mcpOccurrences
      .filter((record) => record.sequence > sequence)
      .map((record) => ({
        sequence: record.sequence,
        serverId: record.serverId,
        event: {
          ...record.event,
          data: { ...record.event.data },
        },
      }));
  }

  getMcpClientState(connectionId, eventName, args = {}) {
    return this.#mcpClientStates.get(
      mcpClientStateKey(connectionId, eventName, args),
    ) ?? null;
  }

  listMcpClientStates(connectionId) {
    return [...this.#mcpClientStates.values()]
      .filter((state) =>
        !connectionId || state.connectionId === String(connectionId)
      );
  }

  async putMcpClientState(input) {
    return this.#serialized(async () => {
      const connectionId = String(input.connectionId || '');
      const eventName = String(input.eventName || '');
      if (!connectionId || !eventName) {
        throw new Error('MCP client state requires connectionId and eventName');
      }
      const args =
        input.arguments && !Array.isArray(input.arguments) && typeof input.arguments === 'object'
          ? input.arguments
          : {};
      const previous = this.getMcpClientState(connectionId, eventName, args);
      const state = {
        connectionId,
        serverId: String(input.serverId || previous?.serverId || connectionId),
        eventName,
        arguments: args,
        subscriptionId:
          input.subscriptionId
            ? String(input.subscriptionId)
            : previous?.subscriptionId ?? null,
        deliveryMode: String(input.deliveryMode || previous?.deliveryMode || 'poll'),
        cursor: input.cursor === null || input.cursor === undefined
          ? null
          : String(input.cursor),
        updatedAt: new Date().toISOString(),
        ...(input.nextPollAt || previous?.nextPollAt
          ? { nextPollAt: String(input.nextPollAt || previous.nextPollAt) }
          : {}),
        ...(input.lastEventAt || previous?.lastEventAt
          ? { lastEventAt: String(input.lastEventAt || previous.lastEventAt) }
          : {}),
        ...(input.lastError
          ? { lastError: String(input.lastError) }
          : {}),
        ...(typeof input.truncated === 'boolean'
          ? { truncated: input.truncated }
          : typeof previous?.truncated === 'boolean'
            ? { truncated: previous.truncated }
            : {}),
      };
      this.#mcpClientStates.set(
        mcpClientStateKey(connectionId, eventName, args),
        state,
      );
      await appendFile(
        this.files.mcpClientStates,
        `${JSON.stringify(state)}\n`,
        'utf8',
      );
      return state;
    });
  }

  getTemporalDeadline(deadlineId) {
    return this.#temporalDeadlines.get(String(deadlineId)) ?? null;
  }

  listTemporalDeadlines({ triggerId, matchId, status } = {}) {
    return [...this.#temporalDeadlines.values()]
      .filter((deadline) => !triggerId || deadline.triggerId === String(triggerId))
      .filter((deadline) => !matchId || deadline.matchId === String(matchId))
      .filter((deadline) => !status || deadline.status === String(status));
  }

  listDueTemporalDeadlines(nowIso) {
    const now = Date.parse(nowIso);
    return this.listTemporalDeadlines({ status: 'pending' })
      .filter((deadline) => Date.parse(deadline.dueAt) <= now)
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  }

  async putTemporalDeadline(input) {
    return this.#serialized(async () => {
      const deadlineId = String(input.deadlineId || '');
      if (!deadlineId || !input.triggerId || !input.matchId || !input.conditionId) {
        throw new Error('Temporal deadline requires deadlineId, triggerId, matchId and conditionId');
      }
      const existing = this.#temporalDeadlines.get(deadlineId);
      const now = new Date().toISOString();
      const deadline = {
        deadlineId,
        triggerId: String(input.triggerId),
        triggerVersion: String(input.triggerVersion || '1'),
        matchId: String(input.matchId),
        conditionId: String(input.conditionId),
        dueAt: String(input.dueAt),
        status: ['pending', 'cancelled', 'fired'].includes(input.status)
          ? input.status
          : existing?.status || 'pending',
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
      if (!Number.isFinite(Date.parse(deadline.dueAt))) {
        throw new Error('Temporal deadline dueAt must be an ISO timestamp');
      }
      this.#temporalDeadlines.set(deadlineId, deadline);
      await appendFile(
        this.files.temporalDeadlines,
        `${JSON.stringify(deadline)}\n`,
        'utf8',
      );
      return deadline;
    });
  }

  async setTemporalDeadlineStatus(deadlineId, status) {
    const existing = this.getTemporalDeadline(deadlineId);
    if (!existing) return null;
    return this.putTemporalDeadline({
      ...existing,
      status,
    });
  }

  getDerivedContract(eventName, contractVersion) {
    return this.#derivedContracts.get(
      `${String(eventName)}@${String(contractVersion)}`,
    ) ?? null;
  }

  listDerivedContracts(eventName) {
    return [...this.#derivedContracts.values()]
      .filter((record) => !eventName || record.eventName === String(eventName))
      .sort((a, b) =>
        a.eventName.localeCompare(b.eventName) ||
        a.contractVersion.localeCompare(b.contractVersion, undefined, { numeric: true })
      );
  }

  async putDerivedContract(recordInput) {
    return this.#serialized(async () => {
      const key =
        `${String(recordInput.eventName)}@${String(recordInput.contractVersion)}`;
      const existing = this.#derivedContracts.get(key);
      const record = {
        eventName: String(recordInput.eventName),
        contractVersion: String(recordInput.contractVersion),
        payloadSchema:
          recordInput.payloadSchema && typeof recordInput.payloadSchema === 'object'
            ? recordInput.payloadSchema
            : {},
        schemaFingerprint: String(recordInput.schemaFingerprint),
        producers: Array.isArray(recordInput.producers)
          ? recordInput.producers.map((producer) => ({
              triggerId: String(producer.triggerId),
              triggerVersion: String(producer.triggerVersion),
            }))
          : existing?.producers ?? [],
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.#derivedContracts.set(key, record);
      await appendFile(
        this.files.derivedContracts,
        `${JSON.stringify(record)}\n`,
        'utf8',
      );
      return record;
    });
  }

  getDerivedEvent(sourceEventId, serverId = 'event-intelligence:derived') {
    return this.#derivedEvents.get(
      `${String(serverId)}::${String(sourceEventId)}`,
    ) ?? null;
  }

  listDerivedEvents({ triggerId, matchId, name } = {}) {
    return [...this.#derivedEvents.values()]
      .filter((record) => !triggerId || record.triggerId === String(triggerId))
      .filter((record) => !matchId || record.matchId === String(matchId))
      .filter((record) => !name || record.event.name === String(name));
  }

  async appendDerivedEvent(recordInput) {
    return this.#serialized(async () => {
      const record = parseDerivedEventRecord(recordInput);
      const key =
        `${record.event.serverId ?? ''}::${record.event.sourceEventId}`;
      const existing = this.#derivedEvents.get(key);
      if (existing) {
        return {
          accepted: false,
          record: existing,
        };
      }
      this.#derivedEvents.set(key, record);
      await appendFile(
        this.files.derivedEvents,
        `${JSON.stringify(record)}\n`,
        'utf8',
      );
      return {
        accepted: true,
        record,
      };
    });
  }

  async appendAudit(input) {
    return this.#serialized(async () => {
      const record = await this.#auditChain.append(input);
      await appendFile(this.files.audit, `${JSON.stringify(record)}\n`, 'utf8');
      return record;
    });
  }

  listAudit({ traceId, afterSequence = -1 } = {}) {
    return this.#auditChain
      .list()
      .filter((record) => record.sequence > afterSequence)
      .filter((record) => !traceId || record.traceId === traceId);
  }

  trace(traceId) {
    return {
      events: this.#events.filter((record) => record.lineage?.traceId === traceId),
      decisions: this.#decisions.filter((record) => record.traceId === traceId),
      wakes: this.#wakes.filter((record) => record.traceId === traceId),
      triggerMatches: this.listTriggerMatches().filter((record) =>
        record.sourceEvents.some((event) => event.traceId === traceId),
      ),
      audit: this.listAudit({ traceId }),
    };
  }

  latestWake(wakeId) {
    return [...this.#wakes].reverse().find((wake) => wake.wakeId === wakeId) ?? null;
  }

  auditLength() {
    return this.#auditChain.list().length;
  }

  async verifyAudit() {
    return this.#auditChain.verify();
  }

  async drain() {
    await this.#queue;
    const scoped = [...this.#scopeStores.values()];
    await Promise.all(scoped.map((store) =>
      typeof store.drain === 'function' ? store.drain() : undefined
    ));
  }

  async close() {
    await this.drain();
  }

  #eventKey(lineage) {
    return `${lineage.environmentId}:${lineage.subscriptionId}:${lineage.sourceEventId}`;
  }

  #triggerKey(definition) {
    return `${definition.triggerId}@${definition.version}`;
  }

  #serialized(operation) {
    const task = this.#queue.then(operation);
    this.#queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
}
