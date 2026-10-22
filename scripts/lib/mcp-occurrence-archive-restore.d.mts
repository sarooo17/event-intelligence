import type { McpOccurrenceArchiveBundle } from './mcp-occurrence-archive-bundle.d.mts';
import type {
  McpOccurrenceArchiveCheckpoint, PostgresEventStore,
} from './postgres-event-store.d.mts';

/**
 * Operator-only isolated disaster recovery of JUST original MCP occurrence
 * and dedup entries; no auto-subscription/wake/match/host delivery and NO
 * authorization to prune the authoritative source or audit history.
 */
export declare function restoreMcpOccurrenceArchiveToIsolatedPostgres(
  store: PostgresEventStore,
  options: {
    archive: McpOccurrenceArchiveBundle;
    /** Separately authenticated and trusted OUTSIDE the archive/database. */
    trustedCheckpoint: McpOccurrenceArchiveCheckpoint;
    confirmIsolatedRestore: 'RESTORE_VERIFIED_SOURCE_TO_ISOLATED_EMPTY_POSTGRES';
    maxOccurrences?: number;
    maxScanMs?: number;
  },
): Promise<Readonly<{
  restoredOccurrences: number;
  restoredDedupKeys: number;
  sourceCheckpoint: Readonly<McpOccurrenceArchiveCheckpoint>;
  targetPrefix: string;
  scopeId: string;
  hostEffectsExecuted: 0;
  productionCutoverAuthorized: false;
}>>;
