import { createHash } from 'node:crypto';
import { verifyMcpOccurrenceArchiveBundle } from './mcp-occurrence-archive-bundle.mjs';

const CONSENT = 'RESTORE_VERIFIED_SOURCE_TO_ISOLATED_EMPTY_POSTGRES';
const INVALID = 'EVENT_INTELLIGENCE_MCP_ARCHIVE_RESTORE_REFUSED';
const RESTORE_MARKER = 'mcp-source-archive-restore';

function refuse(reason) {
  const error = new Error('Refusing isolated MCP source archive restore: ' + reason);
  error.code = INVALID;
  return error;
}

/**
 * DISASTER-RECOVERY STAGING ONLY, never production continuation:
 * restore verified raw MCP source+dedup records to a separate, entirely
 * empty PostgreSQL table prefix. No trigger/match, subscription, wake or
 * provider callback is replayed. No original database rows are deleted.
 *
 * Caller independently authenticates trustedCheckpoint. Confirmation
 * and ei_restore_ prefix are REQUIRED; target must be an initialized
 * empty dedicated PostgreSQL schema with no other tenant data.
 */
export async function restoreMcpOccurrenceArchiveToIsolatedPostgres(store, {
  archive, trustedCheckpoint, confirmIsolatedRestore,
  maxOccurrences = 10000, maxScanMs = 30000,
} = {}) {
  if (confirmIsolatedRestore !== CONSENT ||
      store?.initialized !== true ||
      !store.tablePrefix?.startsWith('ei_restore_') ||
      store.scopeId !== trustedCheckpoint?.scopeId ||
      typeof store.tx !== 'function' ||
      !Number.isSafeInteger(maxOccurrences) || maxOccurrences < 1 ||
      maxOccurrences > 10000 ||
      !Number.isSafeInteger(maxScanMs) || maxScanMs < 100 ||
      maxScanMs > 30000 ||
      !Number.isSafeInteger(trustedCheckpoint?.endSequence) ||
      trustedCheckpoint.endSequence > maxOccurrences ||
      !verifyMcpOccurrenceArchiveBundle(archive, { trustedCheckpoint })) {
    throw refuse('missing operator consent, isolated target or authenticated bounded complete archive');
  }

  const originals = [];
  const keys = new Set();
  let expected = 1;
  for (const page of archive.pages) {
    for (const raw of page.records) {
      let payload;
      try { payload = JSON.parse(raw); } catch { throw refuse('invalid archive JSON'); }
      const subscription = payload?.subscriptionId;
      if (!Number.isSafeInteger(payload?.sequence) ||
          payload.sequence !== expected ||
          typeof payload.serverId !== 'string' ||
          !(subscription === null || typeof subscription === 'string') ||
          typeof payload.event?.eventId !== 'string' ||
          payload.event.eventId.length === 0) {
        throw refuse('noncontiguous source sequence or invalid event identity');
      }
      const key = payload.serverId + ':' + (subscription ?? '') +
        ':' + payload.event.eventId;
      if (keys.has(key)) throw refuse('duplicate durable provider event identity');
      keys.add(key);
      originals.push({ raw, key });
      expected++;
    }
  }
  if (originals.length !== trustedCheckpoint.endSequence) {
    throw refuse('archive length differs from trusted durable source counter');
  }

  try {
    return await store.tx(async client => {
      await client.query("SELECT set_config('statement_timeout', $1, true)",
        [String(maxScanMs) + 'ms']);
      // DDL-free and fail-closed. TABLE locks serialize any competing writers
      // to the dedicated prefix throughout the empty-check and commit.
      await client.query('LOCK TABLE ' + [
        store.metadata, store.records, store.history, store.counters, store.leases,
      ].join(', ') + ' IN SHARE ROW EXCLUSIVE MODE');
      // This marker lives OUTSIDE the disposable event tables and persists
      // even after someone deletes/truncates every restored source row.
      // It is also essential when restoring a legitimately empty archive:
      // there would otherwise be no counter, history or key to fence a
      // second, serialized (apparently successful) empty restore.
      const provenance = await client.query(
        'SELECT component,version,adopted_from FROM ' + store.metadata +
        ' WHERE component IN ($1,$2) FOR UPDATE',
        ['store',RESTORE_MARKER],
      );
      const base = provenance.rows.find(row=>row.component==='store');
      if (!base || Number(base.version)!==1 || base.adopted_from!==null ||
          provenance.rows.some(row=>row.component===RESTORE_MARKER)) {
        throw refuse('target schema is untrusted or previously restored');
      }
      const state = await client.query(
        'SELECT EXISTS(SELECT 1 FROM ' + store.records + ' LIMIT 1) AS records, ' +
        'EXISTS(SELECT 1 FROM ' + store.history + ' LIMIT 1) AS history, ' +
        'EXISTS(SELECT 1 FROM ' + store.counters + ' LIMIT 1) AS counters, ' +
        'EXISTS(SELECT 1 FROM ' + store.leases + ' LIMIT 1) AS leases',
      );
      if (Object.values(state.rows[0] ?? {}).some(value => value !== false)) {
        throw refuse('target prefix is not completely empty');
      }
      const checkpointDigest = createHash('sha256')
        .update(JSON.stringify(trustedCheckpoint)).digest('hex');
      await client.query(
        'INSERT INTO ' + store.metadata +
        ' (component,version,adopted_from) VALUES ($1,$2,$3)',
        [RESTORE_MARKER,1,'mcp-source-archive-sha256:'+checkpointDigest],
      );
      for (const { raw, key } of originals) {
        // All payloads arrive as original PostgreSQL JSONB::text. DO NOT
        // stringify parsed JavaScript Numbers (>2^53 would be destroyed).
        const args = [store.scopeId, key, raw];
        const stored = await client.query(
          'INSERT INTO ' + store.records +
          " (scope_id,kind,record_key,payload) VALUES ($1,'mcp_occurrence_key',$2,$3::jsonb)" +
          ' RETURNING payload::text AS original',
          args,
        );
        if (stored.rows[0]?.original !== raw) {
          throw refuse('restored JSONB canonical source bytes diverged');
        }
        const persisted = await client.query(
          'INSERT INTO ' + store.history +
          " (scope_id,kind,record_key,payload) VALUES ($1,'mcp_occurrence',$2,$3::jsonb)" +
          ' RETURNING payload::text AS original',
          args,
        );
        if (persisted.rows[0]?.original !== raw) {
          throw refuse('restored historical occurrence bytes diverged');
        }
      }
      if (originals.length) {
        await client.query(
          'INSERT INTO ' + store.counters +
          " (scope_id,name,value) VALUES ($1,'mcp_occurrence',$2)",
          [store.scopeId, originals.length],
        );
      }
      return Object.freeze({
        restoredOccurrences: originals.length,
        restoredDedupKeys: originals.length,
        sourceCheckpoint: Object.freeze({ ...trustedCheckpoint }),
        targetPrefix: store.tablePrefix,
        scopeId: store.scopeId,
        hostEffectsExecuted: 0,
        productionCutoverAuthorized: false,
      });
    });
  } catch (error) {
    if (error?.code === '57014') {
      throw refuse('bounded PostgreSQL restore timed out; transaction rolled back');
    }
    throw error;
  }
}
