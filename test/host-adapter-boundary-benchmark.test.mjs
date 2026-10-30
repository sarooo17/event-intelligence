import assert from 'node:assert/strict';
import test from 'node:test';
import {measureHostBoundary} from '../scripts/validation/host-adapter-boundary-benchmark.mjs';

test('bounded diagnostic reports explicit percentiles but never SLO/ROI guarantees',async()=>{
  let now=0,calls=0;
  const r=await measureHostBoundary({
    label:'test-fixture',warmup:2,samples:100,clock:()=>now,
    operation:async()=>{calls++;now+=calls<=2?20:calls-2;},
  });
  assert.equal(calls,102);
  assert.deepEqual([r.p50,r.p95,r.p99,r.max],[50,95,99,100]);
  assert.equal(r.eiCoreOverheadIsolated,false);
  assert.equal(r.productionSloCertified,false);
  assert.equal(r.representativeExternalHostMeasured,false);
  assert.equal(r.samples,100);
});
test('invalid samples, unbounded warmup and broken monotonic clocks fail closed',async()=>{
  for(const options of [{samples:0},{samples:1001},{warmup:101},{operation:null}]){
    await assert.rejects(measureHostBoundary({
      operation:async()=>{},label:'fixture',...options,
    }),TypeError);
  }
  await assert.rejects(measureHostBoundary({
    operation:async()=>{},label:'fixture',samples:20,warmup:0,
    clock:(()=>{let n=10;return()=>n--;})(),
  }),/HOST_BOUNDARY_CLOCK_INVALID/);
});
