import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const runner='scripts/evidence/postgres-os-chaos-soak.mjs';

function run(args, overrides={}){
  return spawnSync(process.execPath,[runner,...args],{
    encoding:'utf8',timeout:10000,
    env:{
      ...process.env,
      POSTGRES_URL:'postgresql://private-user:private-pass@127.0.0.1:1/unused',
      EI_PG_CHAOS_SOAK_CONFIRM:'',
      ...overrides,
    },
  });
}
test('operator chaos evidence rejects no confirmation, missing artifact or out-of-bounds cohorts before touching PG',()=>{
  for(const args of [
    ['--out','never-written.json'],
    ['--rounds','0','--out','never-written.json'],
    ['--rounds','31','--out','never-written.json'],
    ['--cohorts','0','--out','never-written.json'],
    ['--cohorts','13','--out','never-written.json'],
    ['--max-cohort-minutes','31','--out','never-written.json'],
    ['--unknown','1','--out','never-written.json'],
    ['--cohorts','1','--rounds','2'],
  ]){
    const result=run(args);
    assert.equal(result.status,1,args.join(' '));
    assert.equal(result.stdout,'');
    const failure=JSON.parse(result.stderr);
    assert.equal(failure.schema,'ei-pg-chaos-soak-failure-v1');
    assert.equal(failure.status,'failed');
    assert.equal(failure.reason.includes('private-pass'),false);
  }
});
test('even with confirmation, missing PG URL rejects without publishing success',()=>{
  const result=run(['--cohorts','1','--rounds','2',
    '--out','never-written.json'],{
    EI_PG_CHAOS_SOAK_CONFIRM:'YES_DISPOSABLE_PG',
    POSTGRES_URL:'',
  });
  assert.equal(result.status,1);
  assert.equal(JSON.parse(result.stderr).status,'failed');
});
