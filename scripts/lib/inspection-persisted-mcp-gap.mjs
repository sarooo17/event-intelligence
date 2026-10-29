// Read-only bridge from already persisted MCP source completeness state.
// Never accept provider payload claims about unavailable sources or watermarks.
export async function persistedGapInspectionFact(store, {triggerId, triggerVersion, matchId}, {
  boundedSourceLimit=null,
}={}) {
  if(boundedSourceLimit!==null &&
     (!Number.isSafeInteger(boundedSourceLimit) ||
       boundedSourceLimit<1||boundedSourceLimit>100 ||
       typeof store.listBoundedEventSources!=='function')) {
    return null; // Strict mode refuses to fall back to unbounded list.
  }
  if (typeof triggerId !== 'string' || !triggerId ||
      typeof triggerVersion !== 'string' || !triggerVersion ||
      (matchId !== null && typeof matchId !== 'string')) return null;
  const definition = await store.getTrigger(triggerId,triggerVersion);
  if (!definition || definition.triggerId !== triggerId ||
      definition.version !== triggerVersion) return null;
  // The canonical Pattern evaluator already persists bounded-search
  // completeness in trigger.partial audit details. Read the latest match
  // transition, not a stale historical truncated=true from an older run.
  if (matchId && typeof store.getLatestTriggerEvaluationAudit==='function') {
    const audited=await store.getLatestTriggerEvaluationAudit(matchId);
    if (audited?.kind==='trigger.partial' &&
        audited?.entityType==='trigger_match' &&
        audited?.entityId===matchId &&
        audited?.details?.triggerId===triggerId &&
        audited?.details?.triggerVersion===triggerVersion &&
        audited?.details?.truncated===true) {
      return {contract:'ei.inspection-fact.v1',triggerId,triggerVersion,
        matchId,durable:true,kind:'budget_truncated'};
    }
  }
  const state = await store.getTriggerState(triggerId,triggerVersion);
  const attached = state?.connectionIds;
  if (!Array.isArray(attached) || attached.length === 0 || attached.length > 64 ||
      !attached.every(id=>typeof id==='string' && id.length>0)) return null;
  if (!Array.isArray(definition.clauses) || definition.clauses.length>64) return null;
  // The strict PG capability reads a server-side PK ordered LIMIT N+1,
  // never a JS-filtered full event-source inventory. If incomplete, avoid
  // incorrectly claiming the selected source is available/unavailable.
  const page = boundedSourceLimit === null ? null
    : await store.listBoundedEventSources({limit:boundedSourceLimit});
  if(page && (page.hasMore!==false ||
    !Array.isArray(page.records) ||
    page.records.length>boundedSourceLimit)) return null;
  const sources=page ? page.records.filter(source=>
    source.enabled!==false && attached.includes(source.connectionId))
    : await store.listEventSources({connectionIds:attached,enabledOnly:true});
  // Fail closed when source identity is ambiguous or the scoped backing
  // store has not durably recorded this connection's capability.
  if (!Array.isArray(sources) || sources.length > 1024) return null;
  const accepted = new Set(attached);
  for (const clause of definition.clauses) {
    if (!clause.serverId || !clause.event) continue;
    const relevant=sources.filter(s=>
      s.enabled !== false && accepted.has(s.connectionId) &&
      s.serverId === clause.serverId && s.eventName === clause.event);
    if (relevant.length!==1) continue;
    const source=relevant[0];
    const durable=await store.getMcpClientState(
      source.connectionId,clause.event,clause.arguments ?? {},
    );
    if (durable?.connectionId !== source.connectionId ||
        durable?.serverId !== clause.serverId ||
        durable?.eventName !== clause.event ||
        !Number.isSafeInteger(durable.completenessRevision) ||
        durable.completenessRevision < 1) continue;
    if (durable.sourceAvailability === 'not_found') {
      // Narrow, durable SEP-3415 subscription-level NotFound evidence.
      // Never infer generic network outage, missing upstream events or
      // unavailable connection from a local timeout or arbitrary payload.
      return {contract:'ei.inspection-fact.v1',triggerId,triggerVersion,
        matchId,durable:true,kind:'source_unavailable'};
    }
    if(durable.gapUnresolved !== true)continue;
    // A gap is no proof of source unavailability, watermark or impossible match.
    return {
      contract:'ei.inspection-fact.v1',triggerId,triggerVersion,
      matchId,durable:true,kind:'source_gap_unresolved',
    };
  }
  return null;
}
