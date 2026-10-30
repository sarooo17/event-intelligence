// #353 genuine separate OS-process host PG16 delivery/receipt/race evidence.
// Independent host identity and SQL target/membership are operator-provided.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import pg from 'pg';
import {
  expectedGraphReceiptId,initializeOrgGraphExampleSchema,
} from '../examples/host-adapter/multi-org-graph-host.mjs';
const integration=process.env.POSTGRES_URL?test:test.skip;
const worker=fileURLToPath(new URL('../scripts/validation/host-graph-osworker.mjs',import.meta.url));
const graph={runtime:'graph-service',kind:'graph',id:'graph-1'};
const agent={runtime:'graph-service',kind:'agent',id:'agent-1'};
function runWorker(input){
  return new Promise(resolve=>{
    execFile(process.execPath,[worker,JSON.stringify(input)],{
      env:process.env,cwd:process.cwd(),timeout:25000,maxBuffer:1024*64,
    },(error,stdout,stderr)=>{
      let result=null;
      if(stdout.trim())result=JSON.parse(stdout.trim());
      resolve({error,stderr,result});
    });
  });
}
integration('two independent Node host processes commit safe tenant/agent outbox receipts and survive crash/replay', {timeout:90000},async t=>{
  const db=new pg.Pool({connectionString:process.env.POSTGRES_URL,max:4});
  const prefix='ei_oshost_'+randomBytes(6).toString('hex');
  const tables=await initializeOrgGraphExampleSchema(db,prefix);
  t.after(async()=>{
    for(const k of [tables.outbox,tables.targets,tables.members])
      await db.query('DROP TABLE IF EXISTS '+k+' CASCADE');
    await db.end();
  });
  for(const m of [
    ['org-A','team-red','alice',true],
    ['org-A','team-blue','bob',true],
    ['org-B','team-red','carol',true],
  ])await db.query('INSERT INTO '+tables.members+
    ' (org_id,team_id,user_id,active) VALUES($1,$2,$3,$4)',m);
  for(const v of [
    ['org-A','work-1','graph-1','graph-service','graph','team-red','alice',true],
    ['org-A','work-1','agent-1','graph-service','agent','team-blue','bob',true],
    ['org-B','work-1','graph-1','graph-service','graph','team-red','carol',true],
  ])await db.query('INSERT INTO '+tables.targets+
    ' (org_id,workspace_id,target_id,runtime,kind,team_id,owner_id,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',v);
  const cfg=(orgId,wakeId,target=graph,extra={})=>({
    tablePrefix:prefix,orgId,workspaceId:'work-1',wakeId,target,...extra,
  });
  await t.test('concurrent independent workers dedup same-org wake',async()=>{
    const [a,b]=await Promise.all([
      runWorker(cfg('org-A','wake-concurrent')),
      runWorker(cfg('org-A','wake-concurrent')),
    ]);
    assert.equal(a.error,null,a.stderr);
    assert.equal(b.error,null,b.stderr);
    assert.notEqual(a.result.pid,b.result.pid);
    const expected=expectedGraphReceiptId('org-A','work-1','wake-concurrent');
    assert.equal(a.result.receiptId,expected);
    assert.equal(b.result.receiptId,expected);
    const q=await db.query('SELECT count(*)::int AS n FROM '+tables.outbox+
      " WHERE org_id='org-A' AND wake_id='wake-concurrent'");
    assert.equal(q.rows[0].n,1);
  });
  await t.test('same identifiers, distinct orgs and agent kind, spoofed packet cannot route',async()=>{
    const [a,b,c]=await Promise.all([
      runWorker(cfg('org-A','wake-shared',graph,{forgedScope:'org-B'})),
      runWorker(cfg('org-B','wake-shared',graph,{forgedScope:'org-A'})),
      runWorker(cfg('org-A','wake-agent',agent,{forgedScope:'org-B'})),
    ]);
    for(const r of [a,b,c])assert.equal(r.error,null,r.stderr);
    assert.notEqual(a.result.receiptId,b.result.receiptId);
    const q=await db.query('SELECT org_id,owner_id,kind FROM '+tables.outbox+
      " WHERE wake_id IN ('wake-shared','wake-agent') ORDER BY org_id,kind");
    assert.deepEqual(q.rows,[
      {org_id:'org-A',owner_id:'bob',kind:'agent'},
      {org_id:'org-A',owner_id:'alice',kind:'graph'},
      {org_id:'org-B',owner_id:'carol',kind:'graph'},
    ]);
  });
  await t.test('OS SIGKILL post-commit pre-ack is idempotently reconciled',async()=>{
    const victim=await runWorker(cfg('org-A','wake-crash',graph,{crashAfterCommit:true}));
    assert(victim.error);
    assert.equal(victim.error.signal,'SIGKILL');
    const count=await db.query('SELECT count(*)::int AS n FROM '+tables.outbox+
      " WHERE wake_id='wake-crash'");
    assert.equal(count.rows[0].n,1);
    const retry=await runWorker(cfg('org-A','wake-crash'));
    assert.equal(retry.error,null,retry.stderr);
    assert.equal(retry.result.duplicate,true);
    assert.equal(retry.result.receiptId,
      expectedGraphReceiptId('org-A','work-1','wake-crash'));
    const again=await db.query('SELECT count(*)::int AS n FROM '+tables.outbox+
      " WHERE wake_id='wake-crash'");
    assert.equal(again.rows[0].n,1);
  });
  await t.test('revocation inside host database denies fresh post-revoke effect',async()=>{
    await db.query('UPDATE '+tables.members+
      " SET active=FALSE WHERE org_id='org-A' AND team_id='team-red' AND user_id='alice'");
    const rejected=await runWorker(cfg('org-A','wake-revoked'));
    assert(rejected.error);
    const code=JSON.parse(rejected.stderr.trim()).code;
    assert.equal(code,'EVENT_ACTIVATION_TARGET_UNAVAILABLE');
    const q=await db.query('SELECT count(*)::int AS n FROM '+tables.outbox+
      " WHERE wake_id='wake-revoked'");
    assert.equal(q.rows[0].n,0);
  });
});