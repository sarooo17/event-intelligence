import {
  parseCompositeTriggerDefinition,
  sha256Hex,
} from '../../dist/src/intelligenceProtocol/index.js';
import {
  DerivedContractRegistry,
} from './derived-contract-registry.mjs';
import { assertJsonSchemaValue } from './json-schema.mjs';

function actorIdentity(actor) {
  if (!actor || typeof actor !== 'object') {
    throw new Error('actor is required');
  }
  const type = String(actor.type || '');
  const principalId = String(actor.principal_id || '');
  if (!type || !principalId) {
    throw new Error('actor.type and actor.principal_id are required');
  }
  return {
    type,
    principal_id: principalId,
    ...(actor.tenant_id ? { tenant_id: String(actor.tenant_id) } : {}),
  };
}

function samePrincipal(left, right) {
  if (!left || !right) return false;
  return (
    String(left.type || '') === String(right.type || '') &&
    String(left.principal_id || '') === String(right.principal_id || '') &&
    String(left.tenant_id || '') === String(right.tenant_id || '')
  );
}

async function stableId(prefix, input) {
  const hash = await sha256Hex(input);
  return `${prefix}_${hash.slice(0, 24)}`;
}

function sourceKey(eventName, serverId) {
  return `${String(serverId || '')}::${String(eventName || '')}`;
}

const DERIVED_EVENT_SERVER_ID = 'event-intelligence:derived';
const DERIVED_EVENT_CONNECTION_ID = 'event-intelligence:derived';

function getSchemaNode(schema, path) {
  if (!schema || typeof schema !== 'object') return null;
  let node = schema;
  for (const part of String(path).split('.')) {
    if (!node || typeof node !== 'object') return null;
    const properties = node.properties;
    if (!properties || typeof properties !== 'object' || !(part in properties)) {
      return null;
    }
    node = properties[part];
  }
  return node;
}

function scalarSchemaForConstant(value) {
  if (typeof value === 'string') return { type: 'string' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { type: 'integer' } : { type: 'number' };
  }
  return {};
}

function assertSubscriptionArguments(source, args, purpose) {
  const inputSchema = source?.inputSchema;
  if (
    !inputSchema ||
    typeof inputSchema !== 'object' ||
    Object.keys(inputSchema).length === 0
  ) {
    return;
  }
  try {
    assertJsonSchemaValue(inputSchema, args ?? {});
  } catch (error) {
    const wrapped = new Error(
      `${purpose} arguments are invalid for ${source.serverId}/${source.eventName}: ${error instanceof Error ? error.message : String(error)}`,
    );
    wrapped.code = 'TRIGGER_SOURCE_ARGUMENTS_INVALID';
    throw wrapped;
  }
}

function assertAdvertisedPath(source, path, purpose) {
  const payloadSchema = source?.payloadSchema;
  if (
    !payloadSchema ||
    typeof payloadSchema !== 'object' ||
    Object.keys(payloadSchema).length === 0
  ) {
    return;
  }

  if (!getSchemaNode(payloadSchema, path)) {
    const error = new Error(
      `${purpose} field unavailable: ${source.serverId}/${source.eventName}.${path}`,
    );
    error.code = 'TRIGGER_SOURCE_FIELD_UNAVAILABLE';
    throw error;
  }
}

export class TriggerControlPlane {
  constructor({
    store,
    triggerEngine,
    now = () => new Date(),
  }) {
    this.store = store;
    this.triggerEngine = triggerEngine;
    this.now = now;
    this.contractRegistry = new DerivedContractRegistry({
      store,
      now,
      audit: (entry) => this.audit(entry),
    });
  }

  listEventSources({ connectionIds } = {}) {
    return this.store.listEventSources({
      connectionIds,
      enabledOnly: true,
    });
  }

  listTriggers({ owner: ownerInput } = {}) {
    const owner = ownerInput ? actorIdentity(ownerInput) : null;
    return this.store.listTriggers()
      .map((definition) => ({
        definition,
        state: this.store.getTriggerState(
          definition.triggerId,
          definition.version,
        ),
      }))
      .filter((entry) => !owner || samePrincipal(entry.state.owner, owner));
  }

  async registerEventSource(input, actorInput) {
    const actor = actorIdentity(actorInput);
    const source = await this.store.putEventSource(input);

    await this.audit({
      kind: 'event_source.registered',
      entityType: 'event_source',
      entityId: source.sourceId,
      traceId: `event-source:${source.sourceId}`,
      details: {
        actor,
        connectionId: source.connectionId,
        serverId: source.serverId,
        eventName: source.eventName,
      },
    });

    return source;
  }

  async createTrigger({
    definition: definitionInput,
    connectionIds,
    actor: actorInput,
    owner: ownerInput,
    confirmationId,
  }) {
    const actor = actorIdentity(actorInput);
    const owner = actorIdentity(ownerInput);
    if (
      actor.type === 'agent' &&
      (typeof confirmationId !== 'string' || !confirmationId.trim())
    ) {
      const error = new Error(
        'Agent-authored durable triggers require explicit confirmationId',
      );
      error.code = 'TRIGGER_CONFIRMATION_REQUIRED';
      throw error;
    }

    const definition = parseCompositeTriggerDefinition(definitionInput);
    const allowedConnectionIds = Array.isArray(connectionIds)
      ? [...new Set(connectionIds.map(String).filter(Boolean))]
      : [];

    if (!allowedConnectionIds.length) {
      const error = new Error(
        'At least one active event-source connection is required',
      );
      error.code = 'TRIGGER_CONNECTION_REQUIRED';
      throw error;
    }

    this.assertSourcesAvailable(definition, allowedConnectionIds);

    if (this.store.listTriggers().some((candidate) =>
      candidate.triggerId === definition.triggerId &&
      candidate.version === definition.version
    )) {
      const error = new Error(
        `Trigger ${definition.triggerId}@${definition.version} already exists`,
      );
      error.code = 'TRIGGER_ALREADY_EXISTS';
      throw error;
    }

    await this.assertDerivedOutputContract(definition);

    const stored = await this.triggerEngine.register(definition);
    const state = await this.store.setTriggerState(
      stored.triggerId,
      stored.version,
      'active',
      actor,
      {
        owner,
        connectionIds: allowedConnectionIds,
      },
    );

    await this.registerDerivedOutputSource(stored);

    const receiptId = await stableId(
      'trigger_receipt',
      `${stored.triggerId}:${stored.version}:create:${confirmationId || actor.principal_id}`,
    );

    await this.audit({
      kind: 'trigger.created',
      entityType: 'trigger',
      entityId: stored.triggerId,
      traceId: `trigger:${stored.triggerId}`,
      details: {
        actor,
        owner,
        version: stored.version,
        connectionIds: allowedConnectionIds,
        confirmationId: confirmationId || null,
        receiptId,
        clauseSources: stored.clauses.map((clause) => ({
          clauseId: clause.id,
          serverId: clause.serverId,
          eventName: clause.event,
        })),
      },
    });

    return {
      receiptId,
      action: 'create',
      definition: stored,
      state,
    };
  }

  async updateTrigger({
    triggerId,
    expectedVersion,
    definition: definitionInput,
    connectionIds,
    actor: actorInput,
    owner: ownerInput,
    confirmationId,
  }) {
    const actor = actorIdentity(actorInput);
    const owner = actorIdentity(ownerInput);

    if (
      actor.type === 'agent' &&
      (typeof confirmationId !== 'string' || !confirmationId.trim())
    ) {
      const error = new Error(
        'Agent-authored trigger mutations require explicit confirmationId',
      );
      error.code = 'TRIGGER_CONFIRMATION_REQUIRED';
      throw error;
    }

    const current = this.store.listTriggers().find(
      (candidate) =>
        candidate.triggerId === triggerId &&
        candidate.version === expectedVersion,
    );
    if (!current) {
      const error = new Error(
        `Expected trigger version not found: ${triggerId}@${expectedVersion}`,
      );
      error.code = 'TRIGGER_VERSION_CONFLICT';
      throw error;
    }

    const currentState = this.store.getTriggerState(
      triggerId,
      expectedVersion,
    );
    if (!samePrincipal(currentState.owner, owner)) {
      const error = new Error('Trigger owner mismatch');
      error.code = 'TRIGGER_OWNER_MISMATCH';
      throw error;
    }
    if (!['active', 'paused'].includes(currentState.status)) {
      const error = new Error(
        `Trigger version is no longer mutable: ${currentState.status}`,
      );
      error.code = 'TRIGGER_VERSION_CONFLICT';
      throw error;
    }

    const competing = this.store.listTriggers()
      .filter((candidate) => candidate.triggerId === triggerId)
      .find((candidate) => {
        if (candidate.version === expectedVersion) return false;
        const state = this.store.getTriggerState(
          candidate.triggerId,
          candidate.version,
        );
        return state.status === 'active' || state.status === 'paused';
      });
    if (competing) {
      const error = new Error(
        `Another trigger version is current: ${triggerId}@${competing.version}`,
      );
      error.code = 'TRIGGER_VERSION_CONFLICT';
      throw error;
    }

    const definition = parseCompositeTriggerDefinition(definitionInput);
    if (definition.triggerId !== triggerId) {
      const error = new Error('Updated definition must keep triggerId');
      error.code = 'TRIGGER_ID_IMMUTABLE';
      throw error;
    }
    if (definition.version === expectedVersion) {
      const error = new Error('Updated definition requires a new version');
      error.code = 'TRIGGER_NEW_VERSION_REQUIRED';
      throw error;
    }
    if (this.store.listTriggers().some((candidate) =>
      candidate.triggerId === triggerId &&
      candidate.version === definition.version
    )) {
      const error = new Error(
        `Trigger ${triggerId}@${definition.version} already exists`,
      );
      error.code = 'TRIGGER_ALREADY_EXISTS';
      throw error;
    }

    const allowedConnectionIds = Array.isArray(connectionIds) && connectionIds.length
      ? [...new Set(connectionIds.map(String).filter(Boolean))]
      : currentState.connectionIds;

    this.assertSourcesAvailable(definition, allowedConnectionIds);

    await this.retireMatches(
      triggerId,
      expectedVersion,
      'superseded_by_update',
    );
    const retiredState = await this.store.setTriggerState(
      triggerId,
      expectedVersion,
      'completed',
      actor,
      {
        owner,
        connectionIds: currentState.connectionIds,
        fireCount: currentState.fireCount,
        lastFiredAt: currentState.lastFiredAt,
      },
    );

    await this.assertDerivedOutputContract(definition);

    const stored = await this.triggerEngine.register(definition);
    const state = await this.store.setTriggerState(
      stored.triggerId,
      stored.version,
      'active',
      actor,
      {
        owner,
        connectionIds: allowedConnectionIds,
      },
    );

    await this.registerDerivedOutputSource(stored);

    const receiptId = await stableId(
      'trigger_receipt',
      `${triggerId}:${expectedVersion}->${stored.version}:update:${confirmationId || actor.principal_id}`,
    );

    await this.audit({
      kind: 'trigger.updated',
      entityType: 'trigger',
      entityId: triggerId,
      traceId: `trigger:${triggerId}`,
      details: {
        actor,
        owner,
        fromVersion: expectedVersion,
        toVersion: stored.version,
        previousRevision: retiredState.revision,
        newRevision: state.revision,
        receiptId,
        confirmationId: confirmationId || null,
      },
    });

    return {
      receiptId,
      action: 'update',
      previous: {
        definition: current,
        state: retiredState,
      },
      definition: stored,
      state,
    };
  }

  async deleteTrigger({
    triggerId,
    version,
    actor: actorInput,
    owner: ownerInput,
    confirmationId,
  }) {
    const actor = actorIdentity(actorInput);
    const owner = actorIdentity(ownerInput);

    if (
      actor.type === 'agent' &&
      (typeof confirmationId !== 'string' || !confirmationId.trim())
    ) {
      const error = new Error(
        'Agent-authored trigger mutations require explicit confirmationId',
      );
      error.code = 'TRIGGER_CONFIRMATION_REQUIRED';
      throw error;
    }

    const definition = this.store.listTriggers().find(
      (candidate) =>
        candidate.triggerId === triggerId &&
        candidate.version === version,
    );
    if (!definition) {
      const error = new Error(`Unknown trigger ${triggerId}@${version}`);
      error.code = 'TRIGGER_NOT_FOUND';
      throw error;
    }

    const currentState = this.store.getTriggerState(triggerId, version);
    if (!samePrincipal(currentState.owner, owner)) {
      const error = new Error('Trigger owner mismatch');
      error.code = 'TRIGGER_OWNER_MISMATCH';
      throw error;
    }

    await this.retireMatches(triggerId, version, 'trigger_deleted');
    const state = await this.store.setTriggerState(
      triggerId,
      version,
      'deleted',
      actor,
      {
        owner,
        connectionIds: currentState.connectionIds,
        fireCount: currentState.fireCount,
        lastFiredAt: currentState.lastFiredAt,
      },
    );

    const receiptId = await stableId(
      'trigger_receipt',
      `${triggerId}:${version}:delete:${confirmationId || actor.principal_id}:${state.updatedAt}`,
    );

    await this.audit({
      kind: 'trigger.deleted',
      entityType: 'trigger',
      entityId: triggerId,
      traceId: `trigger:${triggerId}`,
      details: {
        actor,
        owner,
        version,
        confirmationId: confirmationId || null,
        receiptId,
      },
    });

    return {
      receiptId,
      action: 'delete',
      definition,
      state,
    };
  }

  async pauseTrigger({
    triggerId,
    version,
    actor: actorInput,
    owner,
    confirmationId,
  }) {
    return this.setTriggerLifecycle({
      triggerId,
      version,
      status: 'paused',
      kind: 'trigger.paused',
      action: 'pause',
      actor: actorInput,
      owner,
      confirmationId,
    });
  }

  async resumeTrigger({
    triggerId,
    version,
    actor: actorInput,
    owner,
    confirmationId,
  }) {
    return this.setTriggerLifecycle({
      triggerId,
      version,
      status: 'active',
      kind: 'trigger.resumed',
      action: 'resume',
      actor: actorInput,
      owner,
      confirmationId,
    });
  }

  async setTriggerLifecycle({
    triggerId,
    version,
    status,
    kind,
    action,
    actor: actorInput,
    owner: ownerInput,
    confirmationId,
  }) {
    const actor = actorIdentity(actorInput);
    const owner = actorIdentity(ownerInput);
    if (
      actor.type === 'agent' &&
      (typeof confirmationId !== 'string' || !confirmationId.trim())
    ) {
      const error = new Error(
        'Agent-authored trigger mutations require explicit confirmationId',
      );
      error.code = 'TRIGGER_CONFIRMATION_REQUIRED';
      throw error;
    }

    const definition = this.store.listTriggers().find(
      (candidate) =>
        candidate.triggerId === triggerId &&
        candidate.version === version,
    );
    if (!definition) {
      const error = new Error(`Unknown trigger ${triggerId}@${version}`);
      error.code = 'TRIGGER_NOT_FOUND';
      throw error;
    }

    const currentState = this.store.getTriggerState(triggerId, version);
    if (!samePrincipal(currentState.owner, owner)) {
      const error = new Error('Trigger owner mismatch');
      error.code = 'TRIGGER_OWNER_MISMATCH';
      throw error;
    }

    if (
      (action === 'pause' && currentState.status !== 'active') ||
      (action === 'resume' && currentState.status !== 'paused')
    ) {
      const error = new Error(
        `Invalid trigger lifecycle transition: ${currentState.status} -> ${status}`,
      );
      error.code = 'TRIGGER_LIFECYCLE_CONFLICT';
      throw error;
    }

    const state = await this.store.setTriggerState(
      triggerId,
      version,
      status,
      actor,
      {
        owner,
        connectionIds: currentState.connectionIds,
      },
    );
    const receiptId = await stableId(
      'trigger_receipt',
      `${triggerId}:${version}:${action}:${confirmationId || actor.principal_id}:${state.updatedAt}`,
    );

    await this.audit({
      kind,
      entityType: 'trigger',
      entityId: triggerId,
      traceId: `trigger:${triggerId}`,
      details: {
        actor,
        owner,
        version,
        confirmationId: confirmationId || null,
        receiptId,
        status,
      },
    });

    return {
      receiptId,
      action,
      definition,
      state,
    };
  }

  assertSourcesAvailable(definition, connectionIds) {
    const allowedConnectionIds = Array.isArray(connectionIds)
      ? [...new Set(connectionIds.map(String).filter(Boolean))]
      : [];
    if (!allowedConnectionIds.length) {
      const error = new Error(
        'At least one active event-source connection is required',
      );
      error.code = 'TRIGGER_CONNECTION_REQUIRED';
      throw error;
    }

    const sources = this.listEventSources({
      connectionIds: allowedConnectionIds,
    });

    const resolveSource = (clause) => {
      if (!clause.serverId) {
        const error = new Error(
          `Trigger clause ${clause.id} must declare serverId`,
        );
        error.code = 'TRIGGER_SOURCE_SCOPE_REQUIRED';
        throw error;
      }

      let candidates = sources.filter(
        (source) =>
          source.eventName === clause.event &&
          source.serverId === clause.serverId,
      );

      if (!candidates.length) {
        const error = new Error(
          `Event source unavailable: ${clause.serverId}/${clause.event}`,
        );
        error.code = 'TRIGGER_EVENT_SOURCE_UNAVAILABLE';
        throw error;
      }

      if (clause.serverId === DERIVED_EVENT_SERVER_ID) {
        const versions = [...new Set(
          candidates
            .map((source) => source.metadata?.contractVersion)
            .filter(Boolean)
            .map(String),
        )];

        if (clause.contractVersion) {
          candidates = candidates.filter(
            (source) =>
              String(source.metadata?.contractVersion || '') ===
              String(clause.contractVersion),
          );
          if (!candidates.length) {
            const error = new Error(
              `Derived contract unavailable: ${clause.event}@${clause.contractVersion}`,
            );
            error.code = 'DERIVED_CONTRACT_NOT_FOUND';
            throw error;
          }
        } else if (versions.length === 1) {
          clause.contractVersion = versions[0];
          candidates = candidates.filter(
            (source) =>
              String(source.metadata?.contractVersion || '') === versions[0],
          );
        } else if (versions.length > 1) {
          const error = new Error(
            `Derived event consumer is ambiguous for ${clause.event}; explicit contractVersion required`,
          );
          error.code = 'DERIVED_CONTRACT_AMBIGUOUS';
          error.details = {
            eventName: clause.event,
            availableVersions: versions,
          };
          throw error;
        }
      }

      return candidates[0];
    };

    for (const clause of definition.clauses) {
      const source = resolveSource(clause);
      assertSubscriptionArguments(
        source,
        clause.arguments ?? {},
        `Trigger clause ${clause.id}`,
      );
      for (const predicate of clause.where ?? []) {
        assertAdvertisedPath(
          source,
          predicate.path,
          `Predicate ${clause.id}`,
        );
      }
    }

    for (const field of definition.correlation?.deterministic?.fields ?? []) {
      const clause = definition.clauses.find(
        (candidate) => candidate.id === field.ref,
      );
      const source = clause ? resolveSource(clause) : null;
      assertAdvertisedPath(
        source,
        field.path,
        `Correlation ${field.ref}`,
      );
    }

    for (const projection of definition.derivedEvent?.projections ?? []) {
      const clause = definition.clauses.find(
        (candidate) => candidate.id === projection.ref,
      );
      const source = clause ? resolveSource(clause) : null;
      const payloadSchema = source?.payloadSchema;
      if (
        payloadSchema &&
        typeof payloadSchema === 'object' &&
        Object.keys(payloadSchema).length
      ) {
        const node = getSchemaNode(payloadSchema, projection.path);
        if (!node) {
          const error = new Error(
            `Derived projection field unavailable: ${projection.ref}.${projection.path}`,
          );
          error.code = 'TRIGGER_DERIVED_PROJECTION_FIELD_UNAVAILABLE';
          throw error;
        }
        const type = Array.isArray(node.type) ? node.type : [node.type];
        if (type.includes('object') || type.includes('array')) {
          const error = new Error(
            `Derived projection must be scalar: ${projection.ref}.${projection.path}`,
          );
          error.code = 'TRIGGER_DERIVED_PROJECTION_NON_SCALAR';
          throw error;
        }
      }
    }

    return allowedConnectionIds;
  }

  buildDerivedOutputPayloadSchema(definition) {
    if (!definition.derivedEvent) return null;

    const properties = {
      _derived: {
        type: 'object',
        properties: {
          triggerId: { type: 'string' },
          triggerVersion: { type: 'string' },
          matchId: { type: 'string' },
          correlationKey: { type: ['string', 'null'] },
          contractVersion: { type: 'string' },
          schemaFingerprint: { type: 'string' },
        },
        required: [
          'triggerId',
          'triggerVersion',
          'matchId',
          'contractVersion',
          'schemaFingerprint',
        ],
      },
    };

    for (const [key, value] of Object.entries(
      definition.derivedEvent.constants ?? {},
    )) {
      properties[key] = scalarSchemaForConstant(value);
    }

    const allSources = this.store.listEventSources();
    for (const projection of definition.derivedEvent.projections ?? []) {
      const clause = definition.clauses.find(
        (candidate) => candidate.id === projection.ref,
      );
      const source = clause
        ? allSources.find(
            (candidate) =>
              candidate.eventName === clause.event &&
              candidate.serverId === clause.serverId &&
              (
                !clause.contractVersion ||
                String(candidate.metadata?.contractVersion || '') ===
                  String(clause.contractVersion)
              ),
          )
        : null;
      properties[projection.key] =
        getSchemaNode(source?.payloadSchema, projection.path) ?? {};
    }

    return {
      type: 'object',
      properties,
      required: [
        '_derived',
        ...Object.keys(definition.derivedEvent.constants ?? {}),
      ],
    };
  }

  async assertDerivedOutputContract(definition) {
    if (!definition.derivedEvent) return null;
    const payloadSchema = this.buildDerivedOutputPayloadSchema(definition);
    try {
      return await this.contractRegistry.assertCompatible({
        eventName: definition.derivedEvent.name,
        contractVersion: definition.derivedEvent.contractVersion,
        payloadSchema,
      });
    } catch (error) {
      if (error?.code === 'DERIVED_CONTRACT_SCHEMA_CONFLICT') {
        await this.audit({
          kind: 'derived_contract.conflict',
          entityType: 'derived_contract',
          entityId:
            `${definition.derivedEvent.name}@${definition.derivedEvent.contractVersion}`,
          traceId:
            `derived-contract:${definition.derivedEvent.name}@${definition.derivedEvent.contractVersion}`,
          details: {
            triggerId: definition.triggerId,
            triggerVersion: definition.version,
            ...(error.details ?? {}),
          },
        });
      }
      throw error;
    }
  }

  async registerDerivedOutputSource(definition) {
    if (!definition.derivedEvent) return null;

    const contractVersion = String(definition.derivedEvent.contractVersion);
    const payloadSchema = this.buildDerivedOutputPayloadSchema(definition);

    const contract = await this.contractRegistry.registerProducer({
      eventName: definition.derivedEvent.name,
      contractVersion,
      payloadSchema,
      producer: {
        triggerId: definition.triggerId,
        triggerVersion: definition.version,
      },
    });

    const sourceId =
      `derived:${definition.triggerId}:${definition.version}:${definition.derivedEvent.name}@${contractVersion}`;
    return this.registerEventSource(
      {
        sourceId,
        connectionId: DERIVED_EVENT_CONNECTION_ID,
        serverId: DERIVED_EVENT_SERVER_ID,
        eventName: definition.derivedEvent.name,
        description:
          `Derived by ${definition.triggerId}@${definition.version} as ${definition.derivedEvent.name}@${contractVersion}`,
        delivery: ['internal'],
        enabled: true,
        experimental: false,
        payloadSchema: contract.record.payloadSchema,
        metadata: {
          derived: true,
          triggerId: definition.triggerId,
          triggerVersion: definition.version,
          contractVersion,
          schemaFingerprint: contract.record.schemaFingerprint,
        },
      },
      {
        type: 'system',
        principal_id: 'event-intelligence:derived-events',
      },
    );
  }

  async retireMatches(triggerId, version, reason) {
    const now = this.now().toISOString();
    const matches = this.store.listTriggerMatches(triggerId)
      .filter((record) =>
        record.triggerVersion === version &&
        (record.status === 'partial' || record.status === 'matched')
      );

    for (const record of matches) {
      await this.store.appendTriggerMatch({
        ...record,
        status: 'expired',
        updatedAt: now,
      });
      for (const deadline of this.store.listTemporalDeadlines?.({
        matchId: record.matchId,
        status: 'pending',
      }) ?? []) {
        await this.store.setTemporalDeadlineStatus?.(
          deadline.deadlineId,
          'cancelled',
        );
      }
    }

    return {
      reason,
      retiredMatchIds: matches.map((record) => record.matchId),
    };
  }

  async audit({
    kind,
    entityType,
    entityId,
    traceId,
    details,
  }) {
    const timestamp = this.now().toISOString();
    await this.store.appendAudit({
      auditId: await stableId(
        'audit',
        `${kind}:${entityType}:${entityId}:${timestamp}:${this.store.auditLength()}`,
      ),
      traceId,
      timestamp,
      kind,
      entityType,
      entityId,
      details,
    });
  }
}
