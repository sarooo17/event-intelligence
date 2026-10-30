import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../scripts/validation/host-tenant-scope-scale.mjs',import.meta.url));
test('separate seeder and measurement OS processes verify actual scheduler intervals and cleanup',()=>{
  const report=JSON.parse(execFileSync(process.execPath,[
    script,'--tiers=1,10','--samples=1',
  ],{cwd:process.cwd(),encoding:'utf8',timeout:55000}));
  assert.equal(report.schema,'ei.host-scope-coldstart.v1');
  for(const row of report.tiers){
    const item=row.samples[0],n=row.scopeCount;
    assert.equal(item.loadedScopes,n);
    assert.equal(item.activeTemporalTimers,n);
    assert.equal(item.activeWakeRetryTimers,n);
    assert(item.observedIntervalHandlesAtStartup>=2*n);
    assert.equal(item.createdIntervalHandles,item.clearedIntervalHandles);
    assert.equal(item.timersAfterClose,0);
    assert.equal(item.productionSloCertified,false);
    assert.equal(item.retainedWakeAfterRestartVerified,false);
    assert(item.rssBeforeBytes>0);
  }
});