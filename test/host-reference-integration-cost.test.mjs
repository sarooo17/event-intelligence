import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readReferenceHostCost,countWholeSource,gitBlobSha,
  PINNED_REFERENCE_HOST_BLOBS,
} from '../scripts/validation/host-reference-integration-cost.mjs';

test('whole EI-maintained reference host files are source-pinned and count their actual production LOC',()=>{
  const r=readReferenceHostCost();
  assert.equal(r.schema,'ei.host-reference-integration-cost.v1');
  assert.equal(r.fixtureAuthorship,'ei-repository-maintained');
  assert.equal(r.independentExternalHostVerified,false);
  assert.deepEqual(
    [r.profiles.headless.physical,r.profiles.multiOrg.physical],
    [79,184],
  );
  assert.deepEqual(
    [r.profiles.headless.nonblank,r.profiles.multiOrg.nonblank],
    [75,179],
  );
  assert.equal(r.combinedHostAdapterPhysicalLines,263);
  assert.equal(r.combinedHostAdapterNonblankLines,254);
  assert.equal(r.newGenericKitRuntimeLOC,0);
  assert.equal(r.netIntegrationROIProven,false);
  assert.equal(r.appBeforeAfterComparable,false);
  assert.equal(r.measuredDeveloperHours,null);
  assert.equal(r.measuredProductionCloudCostUSD,null);
  assert.equal(r.measuredProductionLatencyP99Ms,null);
  assert.equal(r.profiles.headless.gitBlobSha,PINNED_REFERENCE_HOST_BLOBS.headless);
  assert.equal(r.profiles.multiOrg.gitBlobSha,PINNED_REFERENCE_HOST_BLOBS.multiOrg);
});
test('source pin fails closed on modified, removed or nonpublic host adapters',()=>{
  const r=readReferenceHostCost();
  assert.equal(r.profiles.headless.path,'examples/host-adapter/headless-job-host.mjs');
  assert.equal(r.profiles.multiOrg.path,'examples/host-adapter/multi-org-graph-host.mjs');
  const changedRead=(path)=>{
    if(path.endsWith('headless-job-host.mjs'))return 'fake not a public EI import\n';
    if(path.endsWith('multi-org-graph-host.mjs'))return 'fake implementation\n';
    throw new Error('no package manifest loaded after tampered source');
  };
  assert.throws(()=>readReferenceHostCost({read:changedRead}),
    e=>e.code==='HOST_REFERENCE_SOURCE_PIN_MISMATCH');
  assert.deepEqual(countWholeSource('a\n\nb\n'),{
    physical:3,nonblank:2,bytes:5,
  });
  assert.equal(gitBlobSha('a'),gitBlobSha('a'));
  assert.notEqual(gitBlobSha('a'),gitBlobSha('A'));
});
