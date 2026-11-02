import test from 'node:test';
import assert from 'node:assert/strict';
import {safeProfileConfig,latencyStatistics,profileFullInspector,
  classifyInspectorError} from '../scripts/validation/e48b-inspector-profile.mjs';

test('E48-B profiler accepts strict 1k/10k/100k and retains raw p99 samples',()=>{
 const c=safeProfileConfig();
 assert.deepEqual(c.counts,[1000,10000,100000]);
 assert.equal(c.samplesPerPhase,150);
 assert.deepEqual(latencyStatistics([5,4,1,9,3]),{
  n:5,p50:4,p95:9,p99:9,min:1,max:9,mean:4.4});
 for(const bad of [
  {counts:[1000,1000,100000]},
  {counts:[1000,10000,100001]},
  {counts:[100,10000,100000]},
  {counts:[1000,10000]},
  {samplesPerPhase:99},
  {maxHostEvents:2001},
 ])assert.throws(()=>safeProfileConfig(bad),RangeError);
 assert.throws(()=>latencyStatistics([]),TypeError);
 assert.throws(()=>latencyStatistics([1,Infinity]),TypeError);
 assert.equal(classifyInspectorError({code:'private-secret-url'}),'UNKNOWN');
});
test('E48-B measures actual full inspect response/refusal, CPU and RSS without disclosing match IDs',async()=>{
 const inspector={inspect:async({matchId})=>{
  if(matchId==='candidate-000038')throw Object.assign(new Error('private'),{
   code:'EVENT_INTELLIGENCE_INSPECTION_BUDGET_EXCEEDED'});
  return {trigger:{triggerId:'e48-inspected'},match:{matchId},
   diagnosisV2:{kind:'not_yet_satisfied'},lineage:{evidence:[]}};
 }};
 const ids=['candidate-000001','candidate-000038'];
 const result=await profileFullInspector({inspector,ids,iterations:4});
 assert.equal(result.fullInspectorCalls,4);
 assert.equal(result.successes,2);
 assert.equal(result.refusals,2);
 assert.equal(result.samples.length,4);
 assert.equal(result.outcomeCounts.EVENT_INTELLIGENCE_INSPECTION_BUDGET_EXCEEDED,2);
 assert.equal(result.percentileLatencyMs.n,4);
 assert(Number.isFinite(result.processCpuMicros.user));
 assert(result.processRssBytes.peak>=result.processRssBytes.baseline);
 assert(!JSON.stringify(result).includes('candidate-000001'));
 assert(!JSON.stringify(result).includes('private'));
});
