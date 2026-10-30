import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import {measureHostBoundary} from '../scripts/validation/host-adapter-boundary-benchmark.mjs';
import {
  createOrgGraphWakeRuntime,
  createOrgGraphWakeDispatcher,
  expectedGraphReceiptId,
  initializeOrgGraphExampleSchema,
} from '../examples/host-adapter/multi-org-graph-host.mjs';

const url=process.env.POSTGRES_URL;
const pg=url?await import('pg'):null;
const Pool=pg?.Pool??pg?.default?.Pool;
const integration=url?test:test.skip;

const seed={
  activationVersion:'2',
  wake:{wakeId:'wake-org-1',status:'queued',runtimeReceiptId:null,
    matchedAt:'2026-10-30T12:00:00.000Z'},
  target:{runtime:'graph-service',kind:'graph',id:'graph-1'},
  trigger:{triggerId:'multi-org-trigger',version:'1',description:null,
    pattern:{version:'2',root:{kind:'event',ref:'event_1'},partitionBy:[],
      selection:{overlap:'disallow',afterMatch:'skipPastLast',
        maxMatchesPerEvent:10},
      execution:{maxCandidates:512,maxSemanticEvaluations:16,
        maxBufferedEvents:10000}},
    lifecycle:{oneShot:true,cooldownMs:0,completeOnGoal:false}},
  continuation:{instruction:'Wake a host-owned graph checkpoint',
    contextPolicy:{evidence:'matched_events',maxEvents:20,includeData:true}},
  match:{matchId:'match-a',status:'matched',partitionKey:null,
    openedAt:'2026-10-30T12:00:00.000Z',
    updatedAt:'2026-10-30T12:00:00.000Z'},
  evidence:[],trust:{continuation:'configured_trigger_instruction',
    evidence:'untrusted_external_signal'},
};
const signal=(wakeId,kind='graph',targetId='graph-1')=>({
  ...seed,
  wake:{...seed.wake,wakeId},
  target:{runtime:'graph-service',kind,id:targetId},
});

test('graph reference requires host-bound org, workspace, table and PG pool',()=>{
  for(const overrides of [{orgId:''},{workspaceId:''},
    {tablePrefix:'unsafe; DROP TABLE members'},
    {pool:{}},{onCommitted:42}]){
    assert.throws(()=>createOrgGraphWakeRuntime({
      pool:{query(){},connect(){}},tablePrefix:'ei_example_graph',
      orgId:'org-A',workspaceId:'workspace-1',
      ...overrides,
    }),TypeError);
  }
  assert.notEqual(expectedGraphReceiptId('org-A','w1','wake'),
    expectedGraphReceiptId('org-B','w1','wake'));
  assert.notEqual(expectedGraphReceiptId('org-A','w1','wake'),
    expectedGraphReceiptId('org-A','w2','wake'));
});

integration('two real PG16 worker pools: org/team/user/graph scoping, races, revoked membership and durable host receipts',{
  timeout:60000,
},async t=>{
  const suffix=randomBytes(6).toString('hex');
  const prefix='ei_org_graph_'+suffix;
  const aPool=new Pool({connectionString:url,max:4});
  const bPool=new Pool({connectionString:url,max:4});
  const table=await initializeOrgGraphExampleSchema(aPool,prefix);
  t.after(async()=>{
    for(const name of [table.outbox,table.targets,table.members])
      await aPool.query('DROP TABLE IF EXISTS '+name+' CASCADE');
    await Promise.all([aPool.end(),bPool.end()]);
  });
  const members=[
    ['org-A','team-red','alice',true],
    ['org-A','team-blue','bob',true],
    ['org-B','team-red','carol',true],
    ['org-A','team-red','revoked-user',false],
  ];
  for(const m of members)
    await aPool.query(`INSERT INTO ${table.members}
      (org_id,team_id,user_id,active) VALUES($1,$2,$3,$4)`,m);
  const targets=[
    ['org-A','workspace-1','graph-1','graph-service','graph','team-red','alice',true],
    ['org-A','workspace-1','agent-1','graph-service','agent','team-blue','bob',true],
    ['org-A','workspace-1','revoked-graph','graph-service','graph','team-red','revoked-user',true],
    ['org-B','workspace-1','graph-1','graph-service','graph','team-red','carol',true],
    ['org-A','workspace-2','graph-1','graph-service','graph','team-red','alice',true],
  ];
  for(const x of targets)await aPool.query(`INSERT INTO ${table.targets}
    (org_id,workspace_id,target_id,runtime,kind,team_id,owner_id,active)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,x);
  const config=(pool,orgId='org-A',workspaceId='workspace-1',extras={})=>({
    pool,tablePrefix:prefix,orgId,workspaceId,...extras,
  });
  const a=createOrgGraphWakeDispatcher(config(aPool));
  const b=createOrgGraphWakeDispatcher(config(bPool));
  await t.test('real concurrent same-workspace wake dedup uses unique host outbox receipt',async()=>{
    const activation=signal('wake-concurrent');
    const results=await Promise.all(Array.from({length:10},(_,i)=>
      (i%2?a:b)({wake_id:activation.wake.wakeId},activation)));
    assert(results.every(v=>v.runtimeReceiptId===
      expectedGraphReceiptId('org-A','workspace-1',activation.wake.wakeId)));
    const q=await aPool.query(`SELECT count(*)::int AS n FROM ${table.outbox}
      WHERE org_id='org-A' AND workspace_id='workspace-1'
      AND wake_id='wake-concurrent'`);
    assert.equal(q.rows[0].n,1);
    const replayer=createOrgGraphWakeDispatcher(config(bPool));
    assert.equal((await replayer({wake_id:activation.wake.wakeId},activation)).duplicate,true);
  });
  await t.test('identical wake/target id across two organizations and workspaces stay separated',async()=>{
    const v=signal('shared-wake');
    const dB=createOrgGraphWakeDispatcher(config(bPool,'org-B','workspace-1'));
    const dW=createOrgGraphWakeDispatcher(config(aPool,'org-A','workspace-2'));
    const [ra,rb,rw]=await Promise.all([
      a({wake_id:v.wake.wakeId},v),
      dB({wake_id:v.wake.wakeId,scope_id:'forged-org-A'},v),
      dW({wake_id:v.wake.wakeId,scope_id:'forged-org-B'},v),
    ]);
    assert.equal(new Set([ra.runtimeReceiptId,rb.runtimeReceiptId,
      rw.runtimeReceiptId]).size,3);
    const q=await bPool.query(`SELECT org_id,workspace_id,owner_id
      FROM ${table.outbox} WHERE wake_id='shared-wake'
      ORDER BY org_id,workspace_id`);
    assert.deepEqual(q.rows,[
      {org_id:'org-A',workspace_id:'workspace-1',owner_id:'alice'},
      {org_id:'org-A',workspace_id:'workspace-2',owner_id:'alice'},
      {org_id:'org-B',workspace_id:'workspace-1',owner_id:'carol'},
    ]);
    await assert.rejects(
      b({wake_id:v.wake.wakeId},signal('shared-wake','agent','agent-1')),
      /HOST_GRAPH_RECEIPT_COLLISION/,
      'same receipt cannot be reused for different target');
  });
  await t.test('two different agent and graph target kinds need no EI graph topology model',async()=>{
    const v=signal('wake-agent','agent','agent-1');
    const out=await a({wake_id:v.wake.wakeId},v);
    assert.equal(out.runtimeReceiptId,
      expectedGraphReceiptId('org-A','workspace-1','wake-agent'));
    const q=await bPool.query(`SELECT kind,owner_id,team_id FROM ${table.outbox}
      WHERE wake_id='wake-agent'`);
    assert.deepEqual(q.rows[0],{kind:'agent',owner_id:'bob',team_id:'team-blue'});
  });
  await t.test('revoked member and foreign-scoped target cannot produce host effects',async()=>{
    const revoked=signal('wake-revoked','graph','revoked-graph');
    await assert.rejects(a({wake_id:revoked.wake.wakeId},revoked),
      e=>e.code==='EVENT_ACTIVATION_TARGET_UNAVAILABLE');
    const unknown=signal('wake-cross-company','graph','other-company-only');
    await assert.rejects(a({wake_id:unknown.wake.wakeId},unknown),
      e=>e.code==='EVENT_ACTIVATION_TARGET_UNAVAILABLE');
    const q=await bPool.query(`SELECT count(*)::int AS n FROM ${table.outbox}
      WHERE wake_id IN ('wake-revoked','wake-cross-company')`);
    assert.equal(q.rows[0].n,0);
  });
  await t.test('revocation after resolve but before durable effect remains denied',async()=>{
    const port=createOrgGraphWakeRuntime(config(bPool));
    const s=signal('wake-revoke-after-precheck');
    const resolved=await port.resolveTarget(s.target,s);
    assert.equal(resolved.owner_id,'alice');
    await aPool.query(`UPDATE ${table.members} SET active=FALSE
      WHERE org_id='org-A' AND team_id='team-red' AND user_id='alice'`);
    await assert.rejects(
      port.deliver({activation:s,target:resolved,receiptId:
        expectedGraphReceiptId('org-A','workspace-1',s.wake.wakeId)}),
      e=>e.code==='HOST_GRAPH_TARGET_DENIED');
    const q=await aPool.query(`SELECT count(*)::int AS n FROM ${table.outbox}
      WHERE wake_id='wake-revoke-after-precheck'`);
    assert.equal(q.rows[0].n,0);
    await aPool.query(`UPDATE ${table.members} SET active=TRUE
      WHERE org_id='org-A' AND team_id='team-red' AND user_id='alice'`);
  });
  await t.test('bounded real PG16 host target and receipt query latency diagnostics',async()=>{
    // Actual two independent PG pools. Reuse tested authorized target and
    // committed receipt. These are host roundtrip diagnostics, not EI SLOs.
    const host=createOrgGraphWakeRuntime(config(bPool));
    const s=signal('wake-concurrent');
    const id=expectedGraphReceiptId('org-A','workspace-1',s.wake.wakeId);
    const target=await host.resolveTarget(s.target,s);
    assert.equal(target?.owner_id,'alice');
    assert.equal(await host.hasReceipt(id,s),true);
    const targetMs=await measureHostBoundary({
      label:'real-pg16-resolve-target',samples:100,warmup:10,
      operation:async()=>{
        const resolved=await host.resolveTarget(s.target,s);
        assert.equal(resolved?.owner_id,'alice');
      },
    });
    const receiptMs=await measureHostBoundary({
      label:'real-pg16-durable-host-receipt-read',samples:100,warmup:10,
      operation:async()=>assert.equal(await host.hasReceipt(id,s),true),
    });
    for(const report of [targetMs,receiptMs]){
      assert.equal(report.samples,100);
      assert.equal(report.productionSloCertified,false);
      assert.equal(report.eiCoreOverheadIsolated,false);
      assert(Number.isFinite(report.p99));
      assert(report.p99>=report.p95);
      assert(report.p95>=report.p50);
      console.log('EI_HOST_BOUNDARY_DIAGNOSTIC '+JSON.stringify(report));
    }
  });
  await t.test('committed host outbox survives lost acknowledgment, replay on second worker',async()=>{
    let first=true;
    const dying=createOrgGraphWakeDispatcher(config(aPool,'org-A','workspace-1',{
      onCommitted:async()=>{if(first){first=false;throw Error('post-commit pre-ack crash');}},
    }));
    const s=signal('wake-lost-ack');
    const answer=await dying({wake_id:s.wake.wakeId},s);
    assert.equal(answer.duplicate,true);
    assert.equal(answer.runtimeReceiptId,
      expectedGraphReceiptId('org-A','workspace-1','wake-lost-ack'));
    const replay=await b({wake_id:s.wake.wakeId},s);
    assert.equal(replay.duplicate,true);
    const q=await bPool.query(`SELECT count(*)::int AS n FROM ${table.outbox}
      WHERE wake_id='wake-lost-ack'`);
    assert.equal(q.rows[0].n,1);
  });
});
