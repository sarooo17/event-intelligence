import assert from 'node:assert/strict';
import test from 'node:test';
import {countLines,compare,measureSetup} from '../scripts/validation/host-adapter-ergonomics-report.mjs';
test('full-file physical and nonblank LOC are consistently counted',()=>{
  assert.deepEqual(countLines(''),{physical:0,nonblank:0});
  assert.deepEqual(countLines('a\n \nb\n'),{physical:3,nonblank:2});
  assert.deepEqual(countLines('a\r\n \r\nb'),{physical:3,nonblank:2});
  assert.deepEqual(compare('a\nb\n','a\n').delta,{physical:-1,nonblank:-1});
});
test('both host fixture modes yield measured setup and no production claims',async()=>{
  for(const tools of [false,true]){
    const metric=await measureSetup(tools,2);
    assert.equal(metric.samples,2);
    assert.ok(metric.minMs>=0);
    assert.equal(metric.humanIntegrationTimeMeasured,false);
    assert.equal(metric.remoteHostLatencyMeasured,false);
  }
});
