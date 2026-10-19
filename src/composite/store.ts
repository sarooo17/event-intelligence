import type { McpDeliveryGapState } from './deliveryGap.js';
import type {
  CompositeTriggerDefinition,
  CorrelatableEvent,
  TriggerMatchRecord,
} from '../intelligenceProtocol/triggerSchemas.js';

export interface CompositeTriggerStore {
  getMcpGapStateAndSnapshot?():
    | { states: McpDeliveryGapState[]; snapshot: string }
    | Promise<{ states: McpDeliveryGapState[]; snapshot: string }>;
  appendTriggerMatchIfMcpGapUnchanged?(
    record: TriggerMatchRecord,
    expectedSnapshot: string,
    expectedBuffer: TriggerMatchRecord,
  ): Promise<boolean>;
  // The host selects the tenant/scope store before constructing the engine.
  // This is a scope-local, read-only projection of durable transport evidence.
  listMcpClientStates?(connectionId?: string): Array<{
    connectionId: string;
    serverId: string;
    eventName: string;
    arguments?: Record<string, unknown>;
    truncated?: boolean;
    gapUnresolved?: boolean;
    gapDetectedAt?: string;
    completenessRevision?: number;
  }> | Promise<Array<{
    connectionId: string;
    serverId: string;
    eventName: string;
    arguments?: Record<string, unknown>;
    truncated?: boolean;
    gapUnresolved?: boolean;
    gapDetectedAt?: string;
    completenessRevision?: number;
  }>>;
  storeCapabilities?(): {
    partitionLeases?: string;
    [key: string]: unknown;
  };
  claimPartitionLease?(
    partitionKey: string,
    options: {
      workerId: string;
      now?: string;
      leaseMs?: number;
    },
  ): Promise<unknown | null>;
  renewPartitionLease?(
    partitionKey: string,
    options: {
      workerId: string;
      now?: string;
      leaseMs?: number;
    },
  ): Promise<unknown | null>;
  releasePartitionLease?(
    partitionKey: string,
    options: {
      workerId: string;
      now?: string;
    },
  ): Promise<boolean>;
  putTrigger(definition: CompositeTriggerDefinition): Promise<void>;
  listTriggers():
    | CompositeTriggerDefinition[]
    | Promise<CompositeTriggerDefinition[]>;
  /** Optional authoritative scope-local point lookup (no stale cache). */
  getTrigger?(
    triggerId: string,
    version: string,
  ): CompositeTriggerDefinition | null | Promise<CompositeTriggerDefinition | null>;
  /**
   * Optional fresh, scope-local *superset* of possible candidate definitions
   * for a normal event. Include every clause with the matching event name and
   * optional serverId wildcard, plus every definition whose lifecycle can
   * expire/complete on an unrelated event. Must not cache stale definitions,
   * filter by current state/owner, or omit side-effect-capable definitions.
   * Called only for non-timer events; older stores use listTriggers().
   */
  listTriggerCandidatesForEvent?(
    event: Pick<CorrelatableEvent, 'name' | 'serverId'> & { data?: CorrelatableEvent['data'] },
  ):
    | CompositeTriggerDefinition[]
    | Promise<CompositeTriggerDefinition[]>;
  getTriggerState?(
    triggerId: string,
    version: string,
  ):
    | {
        status: 'active' | 'paused' | 'completed' | 'expired' | 'deleted';
        owner?: unknown;
        connectionIds?: string[];
        fireCount?: number;
        lastFiredAt?: string | null;
        revision?: number;
      }
    | null
    | Promise<{
        status: 'active' | 'paused' | 'completed' | 'expired' | 'deleted';
        owner?: unknown;
        connectionIds?: string[];
        fireCount?: number;
        lastFiredAt?: string | null;
        revision?: number;
      } | null>;
  setTriggerState?(
    triggerId: string,
    version: string,
    status: 'active' | 'paused' | 'completed' | 'expired' | 'deleted',
    actor?: unknown,
    metadata?: Record<string, unknown>,
  ): Promise<unknown>;
  appendTriggerMatch(record: TriggerMatchRecord): Promise<void>;
  compareAndAppendTriggerMatch?(
    record: TriggerMatchRecord,
    options: { expectedStatuses: string[] },
  ): Promise<{ applied: boolean; record: TriggerMatchRecord | null }>;
  listTriggerMatches(triggerId?: string):
    | TriggerMatchRecord[]
    | Promise<TriggerMatchRecord[]>;
  getTemporalDeadline?(deadlineId: string): {
    deadlineId: string;
    triggerId: string;
    triggerVersion: string;
    matchId: string;
    conditionId: string;
    dueAt: string;
    status: 'pending' | 'cancelled' | 'fired';
  } | null | Promise<{
    deadlineId: string;
    triggerId: string;
    triggerVersion: string;
    matchId: string;
    conditionId: string;
    dueAt: string;
    status: 'pending' | 'cancelled' | 'fired';
  } | null>;
  listTemporalDeadlines?(filter?: {
    triggerId?: string;
    matchId?: string;
    status?: string;
  }):
    | Array<{
      deadlineId: string;
      triggerId: string;
      triggerVersion: string;
      matchId: string;
      conditionId: string;
      dueAt: string;
      status: string;
    }>
    | Promise<Array<{
      deadlineId: string;
      triggerId: string;
      triggerVersion: string;
      matchId: string;
      conditionId: string;
      dueAt: string;
      status: string;
    }>>;
  putTemporalDeadline?(input: {
    deadlineId: string;
    triggerId: string;
    triggerVersion: string;
    matchId: string;
    conditionId: string;
    dueAt: string;
    status: 'pending' | 'cancelled' | 'fired';
  }): Promise<unknown>;
  setTemporalDeadlineStatus?(
    deadlineId: string,
    status: 'pending' | 'cancelled' | 'fired',
  ): Promise<unknown>;
}

export interface CompositeTriggerAudit {
  appendAudit(input: {
    auditId: string;
    traceId: string;
    timestamp: string;
    kind: string;
    entityType: 'trigger_match' | 'trigger';
    entityId: string;
    details?: Record<string, unknown>;
  }): Promise<unknown>;
}
