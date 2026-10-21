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
