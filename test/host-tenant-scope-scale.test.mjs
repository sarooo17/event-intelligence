import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../scripts/validation/host-tenant-scope-scale.mjs',import.meta.url));
test('isolated reference scopes start and stop two schedulers each',()=>{
  for(const tier of [1,10]){
    const obj=JSON.parse(execFileSync(process.execPath,[
      '--expose-gc',script,'--child='+tier
    ],{cwd:process.cwd(),encoding:'utf8',timeout:45000}));
    assert.equal(obj.schema,'ei.host-scope-coldstart.v1');
    assert.equal(obj.loadedScopes,tier);
    assert.equal(obj.activeTemporalTimers,tier);
    assert.equal(obj.activeWakeRetryTimers,tier);
    assert.equal(obj.timersAfterClose,0);
    assert.equal(obj.productionSloCertified,false);
    assert.equal(obj.retainedWakeAfterRestartVerified,false);
  }
});