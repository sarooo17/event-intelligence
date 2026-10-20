import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const integration = process.env.POSTGRES_URL ? test : test.skip;
const bench = 'scripts/evidence/postgres-mcp-ingest-wake.mjs';

function run(args, overrides = {}, timeout = 45000) {
  return spawnSync(process.execPath,[bench,...args],{
    encoding:'utf8',timeout,
    env:{
      ...process.env,
      EI_PG_PIPELINE_CONFIRM:'YES_ISOLATED',
      EI_PG_PIPELINE_REPEAT_CONFIRM:'YES_ISOLATED_REPEAT',
      ...overrides,
    },
  });
}

test('repeating PG profiles require explicit opt-in and reject unsafe configurations before DB use',()=>{
  const fake='postgresql://unused:unused@127.0.0.1:1/unused';
  for(const [args,env,pattern] of [
    [['--triggers','8','--events','24','--repeat-matches','--rate','1000'],
      {EI_PG_PIPELINE_REPEAT_CONFIRM:''},/repeat-matches requires/],
    [['--triggers','1000','--events','1001','--repeat-matches','--rate','1000'],
      {},/repeat-matches requires/],
    [['--triggers','8','--events','9','--rate','10'],
      {},/rate is permitted only/],
    [['--triggers','8','--events','24','--repeat-matches','--rate','0'],
      {},/rate must be a positive integer/],
    [['--triggers','8','--events','5001','--repeat-matches','--rate','5'],
      {},/events must be a positive integer/],
  ]) {
    const result=run(args,{POSTGRES_URL:fake,...env},10000);
    assert.equal(result.status,1,result.stdout);
    assert.equal(result.stdout,'');
    const output=JSON.parse(result.stderr);
    assert.equal(output.failures[0].phase,'configuration');
    assert.equal(output.failures[0].code,'EI_PG_PIPELINE_CONFIG_INVALID');
    assert.match(output.failures[0].message,pattern);
    assert.ok(!result.stderr.includes('unused:unused'));
  }
});

integration('real PG16 repeated matching: 24 distinct events across 8 triggers retain exactly 24 receipts and no false noise/replay matches',()=>{
  const result=run([
    '--triggers','8','--events','24','--sources','2',
    '--noise','3','--replays','3','--repeat-matches','--rate','1000',
  ],{},60000);
  assert.equal(result.status,0,result.stderr);
  const out=JSON.parse(result.stdout);
  assert.equal(out.status,'completed');
  assert.equal(out.workload.triggers,8);
  assert.equal(out.workload.matchingMcpOccurrences,24);
  assert.equal(out.workload.distinctMatchedTriggerDefinitions,8,
    '24 distinct matches must not be represented as 24 trigger definitions');
  assert.match(out.workload.selection,/round-robin reuse/);
  assert.equal(out.workload.repeatedDistinctOccurrencesAcrossExistingTriggers,true);
  assert.equal(out.workload.requestedMatchingEventsPerSecond,1000);
  assert.equal(out.workload.noiseMcpOccurrences,3);
  assert.equal(out.workload.replayedMcpOccurrences,3);
  assert.equal(out.metrics.matchedCount,24);
  assert.equal(out.metrics.durableWakeCount,24);
  assert.equal(out.metrics.hostSideEffects,24);
  assert.equal(out.metrics.duplicateHostSideEffects,0);
  assert.equal(out.metrics.falsePositiveWakeCount,0);
  assert.equal(out.evidence.persistedReceiptsCheckedAfterPoolReopen,24);
  for(const key of ['ingestToMatch','matchToWake','ingestToWake']) {
    assert.equal(out.metrics[key].samples,24);
    assert.ok(out.metrics[key].p99Ms>=0);
  }
  assert.equal(out.evidence.productionSloCertified,false);
});
