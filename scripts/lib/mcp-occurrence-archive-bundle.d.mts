import type { McpOccurrenceArchiveCheckpoint, McpOccurrenceArchiveWindow } from './postgres-event-store.d.mts';

export interface McpOccurrenceArchiveBundle {
  schema: 'event-intelligence.mcp-occurrence-bundle.v1';
  checkpoint: McpOccurrenceArchiveCheckpoint;
  pageSize: number;
  maxBytes: number;
  pages: McpOccurrenceArchiveWindow[];
}

/** Offline verification against a checkpoint authenticated outside this archive. */
export declare function verifyMcpOccurrenceArchiveBundle(
  bundle: McpOccurrenceArchiveBundle,
  options: { trustedCheckpoint: McpOccurrenceArchiveCheckpoint },
): boolean;

/** Creates a private local file exclusively, never overwrites prior artifacts or deletes DB records. */
export declare function writeMcpOccurrenceArchiveBundle(
  store: { getMcpOccurrenceArchiveWindow(options: {
    checkpoint: McpOccurrenceArchiveCheckpoint;
    afterSequence: number;
    previousHash: string;
    limit: number;
  }): Promise<McpOccurrenceArchiveWindow> },
  options: {
    trustedCheckpoint: McpOccurrenceArchiveCheckpoint;
    outputPath: string;
    pageSize?: number;
    maxBytes?: number;
  },
): Promise<{outputPath:string;bytes:number;endSequence:number;headHash:string}>;

/** Read an operator-owned local file and verify against an *external* trust root. */
export declare function verifyMcpOccurrenceArchiveBundleFile(
  filePath: string,
  options: {trustedCheckpoint:McpOccurrenceArchiveCheckpoint;maxBytes?:number},
): Promise<boolean>;

/**
 * Source-archive offline replay: records are raw authenticated PostgreSQL
 * JSONB text, not JS Number-decoded event payloads. No runtime fallback
 * or permission to prune provider history/dedup/audit is implied.
 */
export declare function readMcpOccurrenceArchiveReplayWindow(
  bundle: McpOccurrenceArchiveBundle,
  options: {
    trustedCheckpoint: McpOccurrenceArchiveCheckpoint;
    afterSequence?: number;
    limit?: number;
  },
): {
  schema: 'event-intelligence.mcp-occurrence-archive-replay.v1';
  scopeId: string;
  afterSequence: number;
  limit: number;
  endSequence: number;
  hasMore: boolean;
  records: ReadonlyArray<Readonly<{sequence:number;rawPayloadJson:string}>>;
};

/** Detached Ed25519 witness over EXACT archived PostgreSQL source bytes. */
export interface McpOccurrenceArchiveWitness {
  schema: 'event-intelligence.mcp-occurrence-witness.v1';
  keyId: string;
  checkpoint: McpOccurrenceArchiveCheckpoint;
  archiveBytes: number;
  archiveSha256: string;
  signature: string;
}
/** Operator-held private key; full checkpoint must be authenticated externally. */
export declare function signMcpOccurrenceArchiveWitness(options:{
  archiveBytes: Buffer;
  trustedCheckpoint: McpOccurrenceArchiveCheckpoint;
  privateKeyPem: string;
  keyId: string;
}): Promise<McpOccurrenceArchiveWitness>;
/** Rejects stale signed prefixes without a separately pinned full checkpoint. */
export declare function verifyMcpOccurrenceArchiveWitness(options:{
  witness: McpOccurrenceArchiveWitness;
  archiveBytes: Buffer;
  trustedCheckpoint: McpOccurrenceArchiveCheckpoint;
  trustedPublicKeyPem: string;
  expectedKeyId: string;
  expectedScopeId: string;
}): Promise<boolean>;
