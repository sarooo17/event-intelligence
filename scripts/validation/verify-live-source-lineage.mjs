// Select the actual fired Pattern v2 match after EI's durable activation.
// A single-shot pattern may also retain an EMPTY partial candidate buffer;
// a nonempty extra partial or a second fired match must never be silently
// counted as evidence of only one logical host effect.
export function verifyLiveFiredSourceLineage({
  matches,sourceEventId,sourceEventTimestamp,
}={}){
  if(!Array.isArray(matches)||matches.length===0||
     matches.length>16||typeof sourceEventId!=='string'||
     !sourceEventId||typeof sourceEventTimestamp!=='string')
    throw new Error('PG_MATCH_COLLECTION_INVALID');
  const fired=matches.filter(x=>x?.status==='fired');
  if(fired.length!==1)throw new Error('PG_FIRED_MATCH_COUNT_INVALID');
  const record=fired[0];
  if(typeof record.firedWakeId!=='string'||!record.firedWakeId||
     !Array.isArray(record.sourceEvents)||record.sourceEvents.length!==1||
     record.sourceEvents[0].sourceEventId!==sourceEventId||
     record.sourceEvents[0].occurredAt!==sourceEventTimestamp)
    throw new Error('PG_FIRED_MATCH_SOURCE_LINEAGE_MISMATCH');
  const other=matches.filter(x=>x!==record);
  if(other.some(x=>x?.status!=='partial'||x?.firedWakeId||
      !Array.isArray(x?.sourceEvents)||x.sourceEvents.length!==0))
    throw new Error('PG_UNEXPECTED_ADDITIONAL_MATCH');
  return Object.freeze({record,
    additionalEmptyCandidateBuffers:other.length,
    actualFiredMatches:fired.length});
}
