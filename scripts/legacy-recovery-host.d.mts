/** Draft host-neutral upgrade/recovery boundary for persisted EI 0.11 JSONL.
 * Not a production cutover API. Node 22+; one-writer offline rehearsal only.
 * Host callbacks MUST enforce their claims independently of EI.
 */
export interface LegacyRecoveryBinding {
  sourceSnapshotSha256: string;
  sourceIdentitySha256: string;
}

export interface LegacyRecoveryExclusiveProof {
  exclusive: true;
  epoch: string;
  runtimeId: string;
  tenantId: string;
  scopeId: 'default';
}

export interface LegacyRecoveryHostPorts {
  runtimeId: string;
  tenantId: string;
  /** Historical v0.11 JSONL recovery supports default only; EI itself supports multi-scope. */
  scopeId?: 'default';
  authority: {
    assertExclusive(input: LegacyRecoveryBinding & {
      runtimeId: string;
      tenantId: string;
      scopeId: 'default';
    }): Promise<LegacyRecoveryExclusiveProof>;
  };
  receipts: {
    lookup(input: {
      runtimeId: string;
      tenantId: string;
      scopeId: 'default';
      epoch: string;
      receiptId: string;
      wakeId: string;
      triggerId: string;
      triggerVersion: string;
    }): Promise<null | {
      receiptId: string;
      wakeId: string;
      runtimeId: string;
      tenantId: string;
      scopeId: 'default';
      state: 'durable';
      principalKind: 'system';
      principalSource: 'automation';
    }>;
  };
  source: {
    attestContinuity(evidence: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  };
  checkpoints: {
    /** MUST read committed state from the host's authoritative durable source-progress storage. */
    readDurable(input: {
      runtimeId: string; tenantId: string; scopeId: 'default';
      epoch: string; connectionId: string; eventName: string; cursor: string;
    }): Promise<null | {
      runtimeId: string;
      tenantId: string;
      scopeId: 'default';
      connectionId: string;
      eventName: string;
      cursor: string;
      durable: true;
      gapUnresolved: false;
      truncated: false;
    }>;
  };
}

export interface LegacyRecoveryHostBridge {
  readonly runtimeId: string;
  readonly tenantId: string;
  readonly scopeId: 'default';
  assertExclusive(binding: {
    expectedSourceSnapshotSha256: string;
    sourceIdentitySha256: string;
  }): Promise<string>;
  lookupReceipt(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  attestSource(evidence: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  readCheckpoint(input: { connectionId: string; eventName: string; cursor: string }): Promise<boolean>;
}

export interface LegacyHostGapJournal {
  readonly tenantId: string;
  readonly sourceSnapshotSha256: string;
  readonly sourceIdentitySha256: string;
  readonly authorityEpoch: string | null;
  assertReady(): Promise<unknown>;
  beginPoll(input: {cursor: string}): Promise<unknown>;
  validated(input: {cursor: string}): Promise<unknown>;
  confirmHostCheckpoint(input: {
    cursor: string;
    checkPersistedCheckpoint: (cursor: string) => Promise<boolean>;
  }): Promise<unknown>;
  block(): Promise<unknown>;
  status(): Promise<{
    schema: string;
    revision: number;
    state: 'ready' | 'polling' | 'checkpoint-required' | 'blocked';
    cursor: string | null;
  }>;
}

export function createLegacyRecoveryHostBridge(ports: LegacyRecoveryHostPorts): LegacyRecoveryHostBridge;

export function openLegacyHostGapJournal(options: {
  directory: string;
  mode: 'create' | 'open';
  tenantId: string;
  sourceSnapshotSha256: string;
  sourceIdentitySha256: string;
  /** Strong host-generated epoch, mandatory when composing the generic bridge. */
  authorityEpoch?: string | null;
}): Promise<LegacyHostGapJournal>;

export interface LegacyRecoveryHostRehearsal {
  readonly status: 'runtime-neutral-offline-replay-rehearsal';
  readonly runtimeId: string;
  readonly tenantId: string;
  readonly safeToResumeOrDeploy: false;
  readonly historicalReceiptsReconciled: number;
  readonly archivedEventIdsCount: number;
  wrapConnection<T extends { request(method: string, params?: unknown): Promise<unknown> }>(
    connection: T
  ): T;
  acknowledgePersistedCheckpoint(input: {
    connectionId: string;
    eventName: string;
    cursor: string;
  }): Promise<unknown>;
  journalStatus(): ReturnType<LegacyHostGapJournal['status']>;
}

export function prepareLegacyHostRecovery(options: {
  host: LegacyRecoveryHostBridge;
  journal: LegacyHostGapJournal;
  sourceDir: string;
  declaredVersion?: '0.11.0';
  expectedSourceSnapshotSha256: string;
  sourceIdentitySha256: string;
}): Promise<LegacyRecoveryHostRehearsal>;
