import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  evaluateV1Readiness, readV1Readiness,
  V1_REQUIRED_CRITERIA,V1_OPTIONAL_CRITERIA,verifyV1ReviewedSource,
} from '../scripts/evidence/v1-release-readiness.mjs';
import {classifySafeReleaseVersion} from '../scripts/evidence/safe-release-channel.mjs';

const ledger=JSON.parse(readFileSync(
  new URL('../docs/releases/v1-readiness.json',import.meta.url)));
const clone=x=>structuredClone(x);

test('stable-v1 candidate reports exactly the release rows still unsigned, with no auto-publish',()=>{
  const report=readV1Readiness();
  const outstanding=V1_REQUIRED_CRITERIA.filter(id=>
    ledger.criteria.find(row=>row.id===id)?.status!=='verified');
  assert.deepEqual(report.errors,[]);
  assert.equal(report.status,outstanding.length?'blocked':'eligible-for-manual-review');
  assert.deepEqual(report.blocked,outstanding);
  assert.equal(report.autoPublish,false);
  assert.equal(report.requiredCount,9);
  assert.equal(report.optionalCount,6);
  assert.equal(V1_REQUIRED_CRITERIA.includes('full-explainability'),true);
  assert.equal(V1_REQUIRED_CRITERIA.includes('semantic-triage'),true);
  assert.equal(ledger.criteria.find(x=>x.id==='full-explainability').required,true);
  assert.equal(ledger.criteria.find(x=>x.id==='semantic-triage').required,true);
  assert.equal(report.blocked.includes('embedded-host-independent'),false);
  assert.equal(ledger.criteria.find(x=>x.id==='embedded-host-independent').required,false);
  assert.equal(ledger.criteria.find(x=>x.id==='embedded-host-independent').status,'blocked');
  assert.equal(report.blocked.includes('security-independent-review'),false);
  assert.equal(report.blocked.includes('pg-scale-measured'),false);
  assert.equal(ledger.criteria.find(x=>x.id==='security-independent-review').issue,317);
  assert.equal(V1_REQUIRED_CRITERIA.includes('pg-retention-audit'),true);
  assert.equal(V1_REQUIRED_CRITERIA.includes('pg-chaos-recovery'),true);
  assert.equal(report.candidateVersion,'1.0.0');
  assert.equal(report.blocked.includes('package-version-not-1.0.0'),false);
  assert.equal(report.blocked.length,outstanding.length);
  assert.equal(report.autoPublish,false);
});

test('ledger rejects missing, duplicated and unknown criteria',()=>{
  for(const mutate of [
    l=>l.criteria.pop(),
    l=>l.criteria.push(clone(l.criteria[0])),
    l=>l.criteria.push({id:'made-up',required:true,status:'verified'}),
    l=>l.targetVersion='0.11.0',
    l=>l.policy='auto-publish',
  ]) {
    const altered=clone(ledger);
    mutate(altered);
    assert.notDeepEqual(evaluateV1Readiness(altered,'1.0.0').errors,[]);
    assert.equal(evaluateV1Readiness(altered,'1.0.0').status,'blocked');
  }
});

test('no required flag can be flipped or marked verified without evidence and review',()=>{
  for(const [id,required] of [
    ...V1_REQUIRED_CRITERIA.map(id=>[id,true]),
    ...V1_OPTIONAL_CRITERIA.map(id=>[id,false]),
  ]) {
    const wrong=clone(ledger);
    wrong.criteria.find(x=>x.id===id).required=!required;
    assert.notDeepEqual(evaluateV1Readiness(wrong,'1.0.0').errors,[]);
  }
  const premature=clone(ledger);
  premature.criteria.find(x=>x.id==='embedded-host-independent').status='verified';
  const rejected=evaluateV1Readiness(premature,'1.0.0');
  assert.ok(rejected.errors.some(x=>x.includes('independent/manual audit evidence')));
  assert.equal(rejected.status,'blocked');
});

test('documented verification structure alone never bypasses other blockers',()=>{
  const isolated=clone(ledger);
  const row=isolated.criteria.find(x=>x.id==='embedded-host-independent');
  row.status='verified';
  row.evidence=['https://github.com/sarooo17/event-intelligence/pull/999'];
  row.verification={
    reviewer:'human-operator',
    procedure:'Manual code and external host behavior review',
    date:'2026-10-18',
  };
  const report=evaluateV1Readiness(isolated,'1.0.0');
  assert.deepEqual(report.errors,[]);
  assert.equal(report.status,'blocked');
  assert.deepEqual(report.blocked,
    V1_REQUIRED_CRITERIA.filter(id=>
      isolated.criteria.find(r=>r.id===id)?.status!=='verified'));
  assert.equal(report.autoPublish,false);
});


test('criteria cannot attach security evidence to integration issue or vice versa',()=>{
  const altered=clone(ledger);
  altered.criteria.find(x=>x.id==='security-independent-review').issue=42;
  altered.criteria.find(x=>x.id==='embedded-host-independent').issue=45;
  const report=evaluateV1Readiness(altered,'1.0.0');
  assert.equal(report.status,'blocked');
  assert.ok(report.errors.some(x=>x.includes('security-independent-review')));
  assert.ok(report.errors.some(x=>x.includes('embedded-host-independent')));
});

test('audit date must be a real past or present UTC calendar day',()=>{
  for(const invalid of [
    '9999-99-99','2026-02-30','2030-01-01',
    '2026-13-01','2026-00-01','2026-10-18T00:00:00Z',
  ]) {
    const altered=clone(ledger);
    const row=altered.criteria.find(x=>x.id==='embedded-host-independent');
    row.status='verified';
    row.evidence=['https://github.com/sarooo17/event-intelligence/pull/188'];
    row.verification={
      reviewer:'independent-reviewer',
      procedure:'Verify third-party host conformance',
      date:invalid,
    };
    const report=evaluateV1Readiness(altered,'1.0.0');
    assert.equal(report.status,'blocked',invalid);
    assert.ok(report.errors.some(x=>x.includes('audit evidence')),invalid);
  }
});

test('owner-waived independent authoring is optional but cannot bypass v1 P0 release gates',()=>{
  const waived=clone(ledger);
  const row=waived.criteria.find(x=>x.id==='embedded-host-independent');
  assert.equal(row.required,false);
  assert.equal(row.status,'blocked');
  assert.equal(evaluateV1Readiness(waived,'1.0.0').status,
    evaluateV1Readiness(ledger,'1.0.0').status);
  const malicious=clone(ledger);
  malicious.criteria.find(x=>x.id==='embedded-host-independent').required=true;
  assert.ok(evaluateV1Readiness(malicious,'1.0.0').errors.some(x=>x.includes('embedded-host-independent')));
  const bypass=clone(ledger);
  for(const r of bypass.criteria)if(r.required){
    r.status='verified';
    delete r.verification;
  }
  assert.ok(evaluateV1Readiness(bypass,'1.0.0').errors.length>=9,
    'independent/manual reviewer and specific evidence mandatory for all nine SDK gates');
});

test('2026-10-31 owner SDK scope decision cannot be bypassed by optionalizing #48 or #49',()=>{
  for(const id of ['full-explainability','semantic-triage']){
    const downgraded=clone(ledger);
    downgraded.criteria.find(x=>x.id===id).required=false;
    const report=evaluateV1Readiness(downgraded,'1.0.0');
    assert.equal(report.status,'blocked');
    assert.ok(report.errors.some(x=>x.includes(id)));
  }
  // Even when all other release gates receive auditor metadata, both
  // unresolved product-owner-required workstreams must independently block.
  const priorGatesVerified=clone(ledger);
  for(const row of priorGatesVerified.criteria){
    if(!row.required)continue;
    if(['full-explainability','semantic-triage'].includes(row.id)){
      row.status='blocked';
      delete row.verification;
      continue;
    }
    row.status='verified';
    row.evidence=['https://github.com/sarooo17/event-intelligence/issues/'+row.issue];
    row.verification={reviewer:'independent-auditor',procedure:'Independent manual acceptance review',date:'2026-10-30'};
  }
  const report=evaluateV1Readiness(priorGatesVerified,'1.0.0');
  assert.deepEqual(report.errors,[]);
  assert.deepEqual(report.blocked,['full-explainability','semantic-triage']);
  assert.equal(report.autoPublish,false);
});


test('2026-10-31 owner scope splits SDK correctness from optional production attestation',()=>{
  const external=['embedded-host-independent','security-independent-review',
    'pg-scale-measured','external-source-finality','provider-billing-and-cancel',
    'production-host-ha-slo'];
  assert.deepEqual([...V1_OPTIONAL_CRITERIA],external);
  assert.equal(V1_REQUIRED_CRITERIA.length,9);
  for(const id of external){
    const row=ledger.criteria.find(x=>x.id===id);
    assert(row,'missing external evidence mapping: '+id);
    assert.equal(row.required,false,id);
    assert.equal(row.status,'blocked',id);
    const wrong=clone(ledger);
    wrong.criteria.find(x=>x.id===id).required=true;
    assert.ok(evaluateV1Readiness(wrong,'1.0.0').errors.some(e=>e.includes(id)),id);
  }
  // External production signoff cannot bypass unsigned SDK core rows.
  // Force the mandatory control rows to blocked even after incremental
  // audited release signoffs begin landing in the real manifest.
  const allExternalApproved=clone(ledger);
  for(const id of ['pg-retention-audit','security-revocation-and-tenant',
    'full-explainability','semantic-triage']){
    const row=allExternalApproved.criteria.find(r=>r.id===id);
    row.status='blocked';
    delete row.verification;
  }
  for(const row of allExternalApproved.criteria){
    if(row.required)continue;
    row.status='verified';
    row.evidence=['https://github.com/sarooo17/event-intelligence/issues/'+row.issue];
    row.verification={reviewer:'operator',
      procedure:'Separate production/enterprise evidence review',
      date:'2026-10-31'};
  }
  const r=evaluateV1Readiness(allExternalApproved,'1.0.0');
  assert.deepEqual(r.errors,[]);
  assert.equal(r.status,'blocked');
  for(const id of ['pg-retention-audit','security-revocation-and-tenant',
    'full-explainability','semantic-triage'])assert.ok(r.blocked.includes(id));
  assert.equal(r.blocked.includes('production-host-ha-slo'),false);
  assert.equal(r.autoPublish,false);
});

test('five source-pinned partial gate signoffs remain BLOCKED until ALL nine pass',()=>{
  const partial=clone(ledger);
  for(const row of partial.criteria)if(row.required){
    row.status='blocked';
    delete row.verification;
  }
  const chosen=['host-contract-and-package','full-explainability',
    'semantic-triage','downstream-pin-policy','pg-chaos-recovery'];
  for(const id of chosen){
    const row=partial.criteria.find(r=>r.id===id);
    row.status='verified';
    row.evidence=['https://github.com/sarooo17/event-intelligence/pull/410'];
    row.verification={reviewer:'reviewer-with-explicit-attribution',
      date:'2026-11-04',procedure:'Review immutable candidate and scoped CI proof',
      sourceCommitSha:'a'.repeat(40)};
  }
  const report=evaluateV1Readiness(partial,'1.0.0',
    {expectedSourceSha:'b'.repeat(40)});
  assert.deepEqual(report.errors,[]);
  assert.deepEqual(report.blocked,V1_REQUIRED_CRITERIA.filter(id=>!chosen.includes(id)));
  assert.equal(report.status,'blocked');
  assert.equal(report.autoPublish,false);
  for(const id of chosen){
    const missing=clone(partial);
    delete missing.criteria.find(r=>r.id===id).verification.sourceCommitSha;
    assert.ok(evaluateV1Readiness(missing,'1.0.0',
      {expectedSourceSha:'b'.repeat(40)}).errors.some(x=>x.includes(id)));
  }
});

test('stable-v1 source signoff pins reviewed ancestor rather than self-referential HEAD',()=>{
  const reviewed='a'.repeat(40),head='b'.repeat(40);
  const signed=clone(ledger);
  for(const row of signed.criteria){
    if(!row.required)continue;
    row.status='verified';
    if(!row.evidence.length)
      row.evidence=['https://github.com/sarooo17/event-intelligence/issues/'+row.issue];
    row.verification={reviewer:'independent-reviewer',date:'2026-11-03',
      procedure:'Inspect code + real PG16 tests before approving candidate',
      sourceCommitSha:reviewed};
  }
  const ready=evaluateV1Readiness(signed,'1.0.0',{expectedSourceSha:head});
  assert.deepEqual(ready.errors,[]);
  assert.equal(ready.status,'eligible-for-manual-review');
  const called=[];
  const git=args=>{
    called.push(args);
    if(args[0]==='rev-parse')return head;
    if(args[0]==='merge-base'||args[0]==='diff')return '';
    throw Error('Unexpected command');
  };
  assert.deepEqual(verifyV1ReviewedSource(signed,head,git),[]);
  assert.deepEqual(called,[
    ['rev-parse','HEAD'],
    ['merge-base','--is-ancestor',reviewed,head],
    ['diff','--quiet',reviewed,head,'--','.',
      ':(exclude)docs/releases/v1-readiness.json'],
  ]);
  assert.equal(ready.autoPublish,false);
});

test('strict release evidence rejects stale trees, missing reviewed SHA and checkout drift',()=>{
  const reviewed='a'.repeat(40),head='b'.repeat(40);
  const signed=clone(ledger);
  for(const row of signed.criteria){
    if(!row.required)continue;
    row.status='verified';
    if(!row.evidence.length)
      row.evidence=['https://github.com/sarooo17/event-intelligence/issues/'+row.issue];
    row.verification={reviewer:'reviewer',date:'2026-11-03',
      procedure:'Reproduce source-pinned evidence',sourceCommitSha:reviewed};
  }
  const missing=clone(signed);
  delete missing.criteria.find(x=>x.id==='full-explainability')
    .verification.sourceCommitSha;
  assert.ok(evaluateV1Readiness(missing,'1.0.0',
    {expectedSourceSha:head}).errors.some(x=>x.includes('full-explainability')));
  assert.ok(evaluateV1Readiness(signed,'1.0.0',
    {expectedSourceSha:'invalid'}).errors.some(x=>x.includes('source SHA')));

  assert.deepEqual(verifyV1ReviewedSource(signed,head,args=>{
    if(args[0]==='rev-parse')return reviewed;
    throw Error('Should stop on HEAD mismatch');
  }),['Checked-out HEAD does not match immutable workflow source SHA']);
  const ancestorFailed=verifyV1ReviewedSource(signed,head,args=>{
    if(args[0]==='rev-parse')return head;
    if(args[0]==='merge-base')throw Error('not ancestor');
    return '';
  });
  assert.ok(ancestorFailed.some(x=>x.includes('not on trusted main baseline')));
  const drift=verifyV1ReviewedSource(signed,head,args=>{
    if(args[0]==='rev-parse')return head;
    if(args[0]==='diff')throw Error('changed runtime code or release notes');
    return '';
  });
  assert.ok(drift.some(x=>x.includes('outside readiness ledger')));
});

test('unmerged branch-only source cannot be attested as if already reviewed on main',()=>{
  const main='b'.repeat(40),unmerged='c'.repeat(40),prHead='d'.repeat(40);
  const staged=clone(ledger);
  for(const row of staged.criteria)if(row.required){
    row.status='blocked';
    delete row.verification;
  }
  const row=staged.criteria.find(r=>r.id==='full-explainability');
  row.status='verified';
  row.verification={reviewer:'bounded AI source audit',date:'2026-11-04',
    procedure:'Review scoped PG16 inspector evidence',
    sourceCommitSha:unmerged};
  const seen=[];
  const git=args=>{
    seen.push(args);
    if(args[0]==='rev-parse')return prHead;
    if(args[0]==='merge-base' &&
       args[2]===main && args[3]===prHead)return '';
    if(args[0]==='merge-base' &&
       args[2]===unmerged && args[3]===main)
      throw Error('reviewed code exists only in PR branch');
    throw Error('untrusted source check: '+args.join(' '));
  };
  const errors=verifyV1ReviewedSource(staged,prHead,git,main);
  assert.ok(errors.some(x=>x.includes('not on trusted main baseline')));
  assert.deepEqual(seen,[
    ['rev-parse','HEAD'],
    ['merge-base','--is-ancestor',unmerged,main],
  ]);
  for(const absent of [null,'invalid']){
    assert.deepEqual(verifyV1ReviewedSource(staged,prHead,git,absent),
      ['Invalid trusted main source SHA']);
  }
  assert.equal(evaluateV1Readiness(staged,'1.0.0').status,'blocked');
});

test('unsigned PR is not blocked merely because trusted main moved ahead',()=>{
  const unsigned=clone(ledger),main='b'.repeat(40),prHead='d'.repeat(40);
  for(const row of unsigned.criteria)if(row.required){
    row.status='blocked';
    delete row.verification;
  }
  const seen=[];
  const check=args=>{
    seen.push(args);
    if(args[0]==='rev-parse')return prHead;
    throw Error('must NOT check main ancestry without a signed gate');
  };
  assert.deepEqual(verifyV1ReviewedSource(unsigned,prHead,check,main),[]);
  assert.deepEqual(seen,[['rev-parse','HEAD']]);
});

test('signed gate requires common reviewed main ancestor and exact code identity on BOTH refs',()=>{
  const approved='a'.repeat(40),main='b'.repeat(40),prHead='c'.repeat(40);
  const signed=clone(ledger);
  for(const row of signed.criteria)if(row.required){
    row.status='blocked';
    delete row.verification;
  }
  const row=signed.criteria.find(r=>r.id==='semantic-triage');
  row.status='verified';
  row.verification={reviewer:'independently-attributed reviewer',
    sourceCommitSha:approved,date:'2026-11-04',
    procedure:'Verify bounded semantic contracts under PG16 multiworker'};
  const seen=[];
  const good=args=>{seen.push(args);
    if(args[0]==='rev-parse')return prHead;
    if(args[0]==='merge-base'||args[0]==='diff')return '';
    throw Error('unexpected Git command');
  };
  assert.deepEqual(verifyV1ReviewedSource(signed,prHead,good,main),[]);
  assert.deepEqual(seen,[
    ['rev-parse','HEAD'],
    ['merge-base','--is-ancestor',approved,main],
    ['merge-base','--is-ancestor',approved,prHead],
    ['diff','--quiet',approved,prHead,'--','.',
      ':(exclude)docs/releases/v1-readiness.json'],
    ['diff','--quiet',approved,main,'--','.',
      ':(exclude)docs/releases/v1-readiness.json'],
  ]);
  const stale=verifyV1ReviewedSource(signed,prHead,args=>{
    if(args[0]==='rev-parse')return prHead;
    if(args[0]==='diff'&&args[3]===main)throw Error('main code changed');
    if(args[0]==='merge-base'||args[0]==='diff')return '';
    throw Error('unexpected Git command');
  },main);
  assert.ok(stale.some(x=>x.includes('differs from reviewed source')));
});

test('npm and MCP stable release workflows fail closed on unsigned 1.0 readiness',()=>{
  const publish=readFileSync(
    new URL('../.github/workflows/publish-npm.yml',import.meta.url),'utf8');
  const release=readFileSync(
    new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
  for(const [workflow,text,finalAction] of [
    ['npm',publish,'npm publish --access public'],
    ['MCP Registry',release,'./mcp-publisher publish server.json'],
  ]){
    assert.ok(text.includes('EI_RELEASE_SOURCE_SHA="$EXPECTED_SOURCE_SHA" node scripts/evidence/v1-release-readiness.mjs --strict'),workflow);
    assert.ok(text.indexOf('v1-release-readiness.mjs --strict') <
      text.indexOf(finalAction),workflow);
    assert.ok(text.includes('test "$(git rev-parse HEAD)" = "$EXPECTED_SOURCE_SHA"'),workflow);
    assert.ok(text.includes('node scripts/evidence/safe-release-channel.mjs "$VERSION"'),workflow);
    assert.ok(text.includes('if [ "$VERSION" = "1.0.0" ]; then'),workflow);
  }
  assert.ok(publish.includes('fetch-depth: 0'));
  assert.ok(publish.includes('Stable npm version already exists; refusing no-op publish'));
  assert.ok(release.includes('head_branch == \'main\''));
  assert.ok(!/^  push:/m.test(release),'Release must not mint stable tags on code pushes');
  const publicCheck=readFileSync(new URL(
    '../.github/workflows/public-release-check.yml',import.meta.url),'utf8');
  assert.ok(publicCheck.includes('git rev-parse --verify refs/remotes/origin/main'));
  assert.ok(publicCheck.includes('EI_RELEASE_REVIEWED_MAIN_SHA="$MAIN_REF"'));
  assert.ok(publicCheck.includes('node scripts/evidence/v1-release-readiness.mjs --review-attestations'));
  assert.ok(publicCheck.includes('fetch-depth: 0'));

});

test('canonical npm release classifier blocks build-metadata downgrade and unreviewed future stable',()=>{
  assert.deepEqual(classifySafeReleaseVersion('0.12.0-next.1'),
    {tag:'next',stableV1:false});
  assert.deepEqual(classifySafeReleaseVersion('1.0.0-rc.1'),
    {tag:'next',stableV1:false});
  assert.deepEqual(classifySafeReleaseVersion('0.11.0'),
    {tag:'latest',stableV1:false});
  assert.deepEqual(classifySafeReleaseVersion('1.0.0'),
    {tag:'latest',stableV1:true});
  for(const invalid of [
    '1.0.0+build-foo','1.0.0+build.foo','1.0.0+evidence-1',
    '01.0.0','1.00.0','1.0.00','1.0.0-rc.01',
    '1.0.0--','1.0.0-rc..1','v1.0.0','1.0','1.0.0 garbage',
    '1.0.1','1.1.0','2.0.0',
  ]) {
    assert.throws(()=>classifySafeReleaseVersion(invalid),
      e=>['EI_RELEASE_VERSION_NOT_CANONICAL','EI_FUTURE_STABLE_POLICY_REQUIRED'].includes(e?.code),invalid);
  }
});
