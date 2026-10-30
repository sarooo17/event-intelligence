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
  // An unavailable/invalid bounded API must NEVER fall back to a full scan.
  if(boundedSourceLimit!==null &&
     (!page || page.hasMore!==false ||
      !Array.isArray(page.records) ||
      page.records.length>boundedSourceLimit)) return null;
  const sources=boundedSourceLimit!==null
    ? page.records.filter(source=>
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
  // A provider-independent host adapter may certify an authoritative,
  // complete event-time frontier for one scoped subscription. EI's own
  // maxObservedOccurredAt is NEVER used here: it cannot prove completeness.
  // Restrict terminal impossibility to a selected partial candidate whose
  // AST is a pure allOf of all trigger event clauses. No OR/sequence/negative/
  // semantic subtree is eligible for this narrowly provable inference.
  if(!matchId || typeof store.getVerifiedInspectionFrontiers!=='function' ||
     typeof store.getTriggerMatch!=='function' ||
     definition.pattern?.root?.kind!=='allOf') return null;
  const children=definition.pattern.root.children;
  if(!Array.isArray(children) || !children.length ||
     children.length!==definition.clauses.length ||
     children.some(node=>node?.kind!=='event'||typeof node.ref!=='string') ||
     new Set(children.map(node=>node.ref)).size!==children.length ||
     !definition.clauses.every(clause=>
       children.some(node=>node.ref===clause.id))) return null;
  // Strict inspection MUST NOT read an unbounded selected match row.
  const selected=boundedSourceLimit===null
    ? await store.getTriggerMatch(matchId)
    : await store.getBoundedInspectionMatch({
        triggerId,version:triggerVersion,matchId,
        maxRowBytes:65536,maxScanMs:2000,
      });
  if(!selected||selected.matchId!==matchId||
     selected.triggerId!==triggerId||
     selected.triggerVersion!==triggerVersion||
     selected.status!=='partial'||
     !Array.isArray(selected.sourceEvents))return null;
  const lateness=definition.eventTime?.allowedLatenessMs??0;
  if(!Number.isSafeInteger(lateness)||lateness<0)return null;
  // A live Pattern V2 buffer is a ROLLING collection of anchors. Its
  // expiresAt is calculated from the FIRST anchor and does not bound all
  // other still-eligible anchors. Prove finality only after the LATEST
  // observed anchor plus the entire trigger window and allowed lateness.
  const role=selected.patternState?.role;
  let cutoff;
  if(role==='buffer'){
    if(!Number.isSafeInteger(definition.withinMs)||
       definition.withinMs<=0||!selected.sourceEvents.length)return null;
    const times=selected.sourceEvents.map(event=>Date.parse(event.occurredAt));
    if(times.some(t=>!Number.isFinite(t)))return null;
    cutoff=Math.max(...times)+definition.withinMs+lateness;
  }else if(role==='match'){
    cutoff=Date.parse(selected.expiresAt)+lateness;
  }else return null; // Do not invent a fixed candidate from legacy state.
  if(!Number.isFinite(cutoff))return null;
  const observed=new Set(selected.sourceEvents.map(e=>e.clauseId));
  const missing=definition.clauses.filter(clause=>!observed.has(clause.id));
  if(!missing.length)return null;
  const requests=[];
  for(const clause of missing){
    if(typeof clause.serverId!=='string'||!clause.serverId||
       typeof clause.event!=='string'||!clause.event)return null;
    const relevant=sources.filter(s=>
      s.enabled!==false && accepted.has(s.connectionId) &&
      s.serverId===clause.serverId && s.eventName===clause.event);
    if(relevant.length!==1)return null;
    requests.push({
      connectionId:relevant[0].connectionId,
      serverId:clause.serverId,eventName:clause.event,
      arguments:clause.arguments??{},
    });
  }
  // All required frontiers are proven within ONE scoped source-revision
  // transaction and bounded advisory-lock window; separate reads could
  // race a newly inserted gap and fabricate terminal evidence.
  const frontiers=await store.getVerifiedInspectionFrontiers(
    requests,{maxScanMs:2000});
  if(!Array.isArray(frontiers)||frontiers.length!==requests.length)return null;
  let belowDeadline=false;
  for(let i=0;i<requests.length;i++){
    const frontier=frontiers[i],source=requests[i];
    if(!frontier||frontier.contract!=='ei.host-verified-source-frontier.v1'||
       frontier.connectionId!==source.connectionId||
       frontier.serverId!==source.serverId||
       frontier.eventName!==source.eventName||
       !Number.isFinite(Date.parse(frontier.completeThroughAt)))return null;
    if(Date.parse(frontier.completeThroughAt)<=cutoff)belowDeadline=true;
  }
  return {
    contract:'ei.inspection-fact.v1',triggerId,triggerVersion,
    matchId,durable:true,
    ...(belowDeadline
      ? {kind:'watermark_pending'}
      : {kind:'candidate_impossible',terminal:true}),
  };
  return null;
}
