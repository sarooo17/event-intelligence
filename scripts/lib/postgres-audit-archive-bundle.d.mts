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
  options: {
    trustedCheckpoint: PostgresAuditCheckpoint;
    /** Exact unparsed original archive bytes: prevents JSON numeric rounding. */
    rawArchiveBytes: Buffer;
  },
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

/** Detached Ed25519 witness for a verified bounded audit archive file. */
export interface PostgresAuditArchiveWitness {
  schema: 'event-intelligence.postgres-audit-witness.v1';
  keyId: string;
  checkpoint: PostgresAuditCheckpoint;
  archiveBytes: number;
  archiveSha256: string;
  signature: string;
}
export declare function signPostgresAuditArchiveWitness(options:{
  /** The *exact* saved file bytes, no JSON parse/serialize substitution. */
  archiveBytes: Buffer;
  /** Independently authenticated scope/genesis/terminal checkpoint. */
  trustedCheckpoint: PostgresAuditCheckpoint;
  /** Operator-held Ed25519 PKCS8 PEM, never checked into this repository. */
  privateKeyPem: string;
  keyId: string;
}): Promise<PostgresAuditArchiveWitness>;
export declare function verifyPostgresAuditArchiveWitness(options:{
  witness: PostgresAuditArchiveWitness;
  archiveBytes: Buffer;
  /** Externally pinned Ed25519 SPKI PEM; never from this witness itself. */
  trustedPublicKeyPem: string;
  expectedKeyId: string;
  expectedScopeId: string;
}): Promise<boolean>;
