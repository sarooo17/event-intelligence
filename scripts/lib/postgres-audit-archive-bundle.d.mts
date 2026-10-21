export interface PostgresAuditCheckpoint {
  scopeId: string;
  firstHash: string | null;
  endSequence: number;
  headHash: string | null;
}
export interface PostgresAuditProofWindow {
  scopeId: string;
  afterSequence: number;
  previousHash: string | null;
  limit: number;
  records: unknown[];
  endSequence: number;
  headHash: string | null;
  hasMore: boolean;
}
export interface PostgresAuditArchiveBundle {
  schema: 'event-intelligence.postgres-audit-bundle.v1';
  checkpoint: PostgresAuditCheckpoint;
  pageSize: number;
  maxBytes: number;
  pages: PostgresAuditProofWindow[];
}
export declare function verifyPostgresAuditArchiveBundle(
  bundle: PostgresAuditArchiveBundle,
  options: { trustedCheckpoint: PostgresAuditCheckpoint },
): Promise<boolean>;
export declare function writePostgresAuditArchiveBundle(
  store: {getAuditProofWindow(options: {
    checkpoint: PostgresAuditCheckpoint;
    afterSequence: number;
    limit: number;
  }): Promise<PostgresAuditProofWindow>},
  options: {
    trustedCheckpoint: PostgresAuditCheckpoint;
    outputPath: string;
    pageSize?: number;
    maxBytes?: number;
  },
): Promise<{outputPath:string;bytes:number;endSequence:number;headHash:string|null}>;
export declare function verifyPostgresAuditArchiveBundleFile(
  filePath:string,
  options: {trustedCheckpoint:PostgresAuditCheckpoint;maxBytes?:number},
): Promise<boolean>;
