import {
  AuditRecordSchema,
  type AuditRecord,
  type LifecycleState,
} from './schemas.js';
import { canonicalJson, sha256Hex } from './canonical.js';
import { assertTransition } from './lifecycle.js';

export interface AppendAuditInput {
  auditId: string;
  traceId: string;
  timestamp: string;
  kind: AuditRecord['kind'];
  entityType: AuditRecord['entityType'];
  entityId: string;
  fromState?: LifecycleState | null;
  toState?: LifecycleState | null;
  details?: Record<string, unknown>;
}

export class AuditChain {
  private readonly records: AuditRecord[];

  constructor(initialRecords: AuditRecord[] = []) {
    this.records = initialRecords.map((record) => AuditRecordSchema.parse(record));
  }

  async append(input: AppendAuditInput): Promise<AuditRecord> {
    if (input.fromState && input.toState) {
      assertTransition(input.fromState, input.toState);
    }

    const previousHash =
      this.records.length === 0
        ? null
        : this.records[this.records.length - 1]!.hash;

    const unsigned = {
      auditId: input.auditId,
      sequence: this.records.length,
      traceId: input.traceId,
      timestamp: input.timestamp,
      kind: input.kind,
      entityType: input.entityType,
      entityId: input.entityId,
      ...(input.fromState !== undefined ? { fromState: input.fromState } : {}),
      ...(input.toState !== undefined ? { toState: input.toState } : {}),
      details: input.details ?? {},
      previousHash,
    };

    const hash = await sha256Hex(canonicalJson(unsigned));
    const record = AuditRecordSchema.parse({ ...unsigned, hash });
    this.records.push(record);
    return record;
  }

  list(): AuditRecord[] {
    return this.records.map((record) => ({
      ...record,
      details: { ...record.details },
    }));
  }

  async verify(): Promise<boolean> {
    let previousHash: string | null = null;

    for (let index = 0; index < this.records.length; index += 1) {
      const record = this.records[index]!;
      if (record.sequence !== index) return false;
      if (record.previousHash !== previousHash) return false;

      const { hash, ...unsigned } = record;
      const expected = await sha256Hex(canonicalJson(unsigned));
      if (hash !== expected) return false;

      previousHash = hash;
    }

    return true;
  }
}
