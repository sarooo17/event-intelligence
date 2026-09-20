import type {
  CompositeTriggerDefinition,
  TriggerMatchRecord,
} from '../intelligenceProtocol/triggerSchemas.js';

export interface CompositeTriggerStore {
  putTrigger(definition: CompositeTriggerDefinition): Promise<void>;
  listTriggers(): CompositeTriggerDefinition[];
  getTriggerState?(
    triggerId: string,
    version: string,
  ): {
    status: 'active' | 'paused' | 'completed' | 'expired' | 'deleted';
    owner?: unknown;
    connectionIds?: string[];
    fireCount?: number;
    lastFiredAt?: string | null;
    revision?: number;
  } | null;
  setTriggerState?(
    triggerId: string,
    version: string,
    status: 'active' | 'paused' | 'completed' | 'expired' | 'deleted',
    actor?: unknown,
    metadata?: Record<string, unknown>,
  ): Promise<unknown>;
  appendTriggerMatch(record: TriggerMatchRecord): Promise<void>;
  listTriggerMatches(triggerId?: string): TriggerMatchRecord[];
  getTemporalDeadline?(deadlineId: string): {
    deadlineId: string;
    triggerId: string;
    triggerVersion: string;
    matchId: string;
    conditionId: string;
    dueAt: string;
    status: 'pending' | 'cancelled' | 'fired';
  } | null;
  listTemporalDeadlines?(filter?: {
    triggerId?: string;
    matchId?: string;
    status?: string;
  }): Array<{
    deadlineId: string;
    triggerId: string;
    triggerVersion: string;
    matchId: string;
    conditionId: string;
    dueAt: string;
    status: string;
  }>;
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
