import type { EventIntelligenceStoreCapabilities } from '../host-integration.d.mts';

export interface PostgresQueryResult<Row = any> {
  rows: Row[];
  rowCount?: number | null;
}

export interface PostgresQueryClient {
  query<Row = any>(text: string, values?: unknown[]): Promise<PostgresQueryResult<Row>>;
}

export interface PostgresPoolClient extends PostgresQueryClient {
  release(): void;
}

export interface PostgresPoolLike extends PostgresQueryClient {
  connect(): Promise<PostgresPoolClient>;
  end?(): Promise<void>;
}

export interface PostgresEventStoreOptions {
  pool: PostgresPoolLike;
  scopeId?: string;
  tablePrefix?: string;
  ownsPool?: boolean;
  /** Only after a verified backup and operator approval; never auto-adopts data. */
  adoptUnversionedSchema?: boolean;
}

export declare const POSTGRES_PERSISTED_SCHEMA_VERSION: 1;

export declare const POSTGRES_STORE_CAPABILITIES: Readonly<{
  version: '1';
  sharedState: 'strong';
  scopeIsolation: 'strong';
  wakeClaims: 'distributed-atomic';
  partitionLeases: 'distributed-atomic';
  mutableCompaction: 'database-managed';
  readModel: 'postgres-authoritative';
}>;

export declare class PostgresEventStore {
  constructor(options: PostgresEventStoreOptions);
  readonly pool: PostgresPoolLike;
  readonly scopeId: string;
  readonly tablePrefix: string;
  readonly ownsPool: boolean;
  readonly adoptUnversionedSchema: boolean;
  storeCapabilities(): EventIntelligenceStoreCapabilities;
  init(): Promise<Record<string, number>>;
  forScope(scopeId?: string): Promise<PostgresEventStore>;
  listScopeIds(): Promise<string[]>;

  appendWake(record: any): Promise<any>;
  latestWake(wakeId: string): Promise<any | null>;
  getWakeDelivery(wakeId: string): Promise<any | null>;
  listDueWakeDeliveries(nowIso?: string): Promise<any[]>;
  ensureWakeDelivery(input: any): Promise<any>;
  claimWakeDelivery(wakeId: string, options: {
    workerId: string;
    now?: string;
    leaseMs?: number;
  }): Promise<any | null>;
  completeWakeDelivery(wakeId: string, options: {
    workerId: string;
    runtimeReceiptId: string;
    now?: string;
  }): Promise<any | null>;
  failWakeDelivery(wakeId: string, options: {
    workerId: string;
    error?: unknown;
    now?: string;
    maxAttempts?: number;
    nextAttemptAt?: string;
  }): Promise<any | null>;

  putTrigger(definition: any): Promise<any>;
  listTriggers(): Promise<any[]>;
  getTriggerState(triggerId: string, version: string): Promise<any>;
  setTriggerState(
    triggerId: string,
    version: string,
    status: string,
    actor?: any,
    metadata?: Record<string, any>,
  ): Promise<any>;
  listTriggerStates(): Promise<any[]>;
  putEventSource(input: any): Promise<any>;
  listEventSources(options?: {
    connectionIds?: string[];
    enabledOnly?: boolean;
  }): Promise<any[]>;
  appendTriggerMatch(record: any): Promise<any>;
  compareAndAppendTriggerMatch(
    record: any,
    options: { expectedStatuses: string[] },
  ): Promise<{ applied: boolean; record: any | null }>;
  listTriggerMatches(triggerId?: string): Promise<any[]>;
  listTriggerMatchHistory(matchId?: string): Promise<any[]>;
  /** Bounded, scope-constrained history ordered oldest-to-newest. */
  getRecentTriggerMatchHistory(
    matchId: string,
    options?: { limit?: number },
  ): Promise<{ records: any[]; hasMore: boolean; limit: number }>;

  appendMcpOccurrence(serverId: string, event: any, subscriptionId?: string | null): Promise<{
    accepted: boolean;
    sequence: number | null;
    event: any;
  }>;
  latestMcpEventSequence(): Promise<number>;
  listMcpOccurrencesAfter(sequence: number): Promise<any[]>;
  getMcpClientState(connectionId: string, eventName: string, args?: Record<string, unknown>): Promise<any | null>;
  listMcpClientStates(connectionId?: string): Promise<any[]>;
  putMcpClientState(input: any): Promise<any>;

  getTemporalDeadline(deadlineId: string): Promise<any | null>;
  listTemporalDeadlines(options?: Record<string, unknown>): Promise<any[]>;
  listDueTemporalDeadlines(nowIso: string): Promise<any[]>;
  putTemporalDeadline(input: any): Promise<any>;
  setTemporalDeadlineStatus(deadlineId: string, status: string): Promise<any | null>;

  getDerivedContract(eventName: string, contractVersion: string): Promise<any | null>;
  listDerivedContracts(eventName?: string): Promise<any[]>;
  putDerivedContract(input: any): Promise<any>;
  getDerivedEvent(sourceEventId: string, serverId?: string): Promise<any | null>;
  listDerivedEvents(options?: Record<string, unknown>): Promise<any[]>;
  appendDerivedEvent(input: any): Promise<{ accepted: boolean; record: any }>;

  getPartitionLease(partitionKey: string): Promise<any | null>;
  claimPartitionLease(partitionKey: string, options: {
    workerId: string;
    now?: string;
    leaseMs?: number;
  }): Promise<any | null>;
  renewPartitionLease(partitionKey: string, options: {
    workerId: string;
    now?: string;
    leaseMs?: number;
  }): Promise<any | null>;
  releasePartitionLease(partitionKey: string, options: {
    workerId: string;
    now?: string;
  }): Promise<boolean>;

  compactMutableState(): Promise<any>;
  getSemanticDecisionCache(key: string): Promise<any | null>;
  putSemanticDecisionCache(key: string, decision: any): Promise<any>;
  semanticDecisionCacheSize(): Promise<number>;
  appendAudit(input: any): Promise<any>;
  listAudit(options?: { traceId?: string; afterSequence?: number }): Promise<any[]>;
  trace(traceId: string): Promise<any>;
  auditLength(): Promise<number>;
  verifyAudit(): Promise<boolean>;
  drain(): Promise<void>;
  close(): Promise<void>;
}
