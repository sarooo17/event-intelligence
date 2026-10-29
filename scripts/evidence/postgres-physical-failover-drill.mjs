import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
const { Pool } = pg;

const FAIL = reason => { throw new Error('EI_PHYSICAL_FAILOVER_REFUSED:' + reason); };
const confirm = process.env.EI_DISPOSABLE_PHYSICAL_FAILOVER_CONFIRM;
const primaryUrl = process.env.EI_PG_FAILOVER_PRIMARY_URL;
const standbyUrl = process.env.EI_PG_FAILOVER_STANDBY_URL;
const output = process.env.EI_PG_FAILOVER_OUTPUT || 'pg-physical-failover.json';
if (confirm !== 'YES_TWO_DISPOSABLE_DOCKER_POSTGRES_INSTANCES') FAIL('explicit-disposable-confirmation-required');
for (const [name,value,port] of [['primary',primaryUrl,'25432'],['standby',standbyUrl,'25433']]) {
  if (!value) FAIL(name+'-url-required');
  let url; try { url=new URL(value); } catch { FAIL(name+'-url-invalid'); }
  if (url.protocol !== 'postgresql:' || !['127.0.0.1','localhost'].includes(url.hostname) ||
      url.port !== port || url.pathname !== '/postgres') FAIL(name+'-url-outside-disposable-localhost');
}
// The only permitted docker target is the workflow's explicitly labeled
// ephemeral primary. A wrong container name or label refuses the kill.
const name = 'ei-pg-ha-disposable-primary';
const inspect = spawnSync('docker',['inspect','--format','{{ index .Config.Labels "ei.disposable" }}',name],
  {encoding:'utf8',timeout:10000});
if (inspect.status !== 0 || inspect.stdout.trim() !== 'yes') FAIL('docker-primary-not-labeled-disposable');

const primary = new Pool({connectionString:primaryUrl,max:2,connectionTimeoutMillis:5000});
const standby = new Pool({connectionString:standbyUrl,max:2,connectionTimeoutMillis:5000});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sourceCommitSha=process.env.EI_FAILOVER_SOURCE_SHA||process.env.GITHUB_SHA||null;
let killed=false;
try {
  const [p,s]=await Promise.all([
    primary.query('SELECT version() AS version, pg_is_in_recovery() AS recovering'),
    standby.query('SELECT version() AS version, pg_is_in_recovery() AS recovering'),
  ]);
  if (p.rows[0].recovering !== false || s.rows[0].recovering !== true ||
      !p.rows[0].version.includes('PostgreSQL 16') || !s.rows[0].version.includes('PostgreSQL 16')) {
    FAIL('expected-primary-and-replica-postgres16');
  }
  const streaming = await primary.query("SELECT application_name,sync_state,state FROM pg_stat_replication WHERE application_name='ei_standby'");
  if (streaming.rows.length !== 1 || streaming.rows[0].sync_state !== 'sync' ||
      streaming.rows[0].state !== 'streaming') FAIL('synchronous-standby-not-verified');

  // Only *acknowledged synchronous remote_apply commits* are covered by RPO=0.
  // An unacknowledged in-flight transaction is deliberately not called durable.
  const db=await primary.connect();
  const rows=200;
  try {
    await db.query("SET synchronous_commit='remote_apply'");
    await db.query('CREATE TABLE ei_physical_disposable_receipts (id integer PRIMARY KEY, payload_sha256 text NOT NULL)');
    for(let id=1;id<=rows;id++) {
      const hash=createHash('sha256').update('durably-acked:'+id).digest('hex');
      await db.query('INSERT INTO ei_physical_disposable_receipts(id,payload_sha256) VALUES($1,$2)',[id,hash]);
    }
  } finally {db.release();}
  const check=async pool=>{
    const result=await pool.query('SELECT id,payload_sha256 FROM ei_physical_disposable_receipts ORDER BY id');
    if (result.rows.length !== rows) return false;
    return result.rows.every((x,i)=>x.id===i+1 &&
      x.payload_sha256===createHash('sha256').update('durably-acked:'+(i+1)).digest('hex'));
  };
  if (!await check(standby)) FAIL('standby-did-not-replay-every-acknowledged-commit');

  const killStarted=performance.now();
  const killedResult=spawnSync('docker',['kill','--signal=SIGKILL',name],
    {encoding:'utf8',timeout:15000});
  if(killedResult.status!==0) FAIL('primary-kill-failed');
  killed=true;
  // Promote the physically separate database process; a PostgreSQL client
  // restart on the original primary would not satisfy this test.
  const promoted=await standby.query('SELECT pg_promote(true, 30) AS promoted');
  if(promoted.rows[0]?.promoted!==true) FAIL('standby-promotion-not-confirmed');
  const maxRtoMs=30000; // declared bounded CI drill budget, NOT production SLA.
  let ready=false;
  while(performance.now()-killStarted<maxRtoMs) {
    try {
      const status=await standby.query('SELECT pg_is_in_recovery() AS recovering');
      if(status.rows[0].recovering===false) {
        await standby.query("INSERT INTO ei_physical_disposable_receipts(id,payload_sha256) VALUES(201,'post-promotion-write')");
        ready=true; break;
      }
    } catch {}
    await sleep(100);
  }
  const measuredRtoMs=performance.now()-killStarted;
  if(!ready) FAIL('rto-exceeded-disposable-budget');
  const records=await standby.query('SELECT id,payload_sha256 FROM ei_physical_disposable_receipts ORDER BY id');
  const confirmed=records.rows.filter(x=>x.id<=rows);
  const missing=Array.from({length:rows},(_,i)=>i+1).filter(id=>!confirmed.some(x=>x.id===id));
  const modified=confirmed.filter(x=>x.payload_sha256!==
    createHash('sha256').update('durably-acked:'+x.id).digest('hex'));
  const last=records.rows.find(x=>x.id===201);
  const report={
    schema:'event-intelligence.disposable-physical-pg16-failover.v1',
    sourceCommitSha,
    topology:'two distinct PostgreSQL 16 container processes; physical WAL streaming same CI runner',
    mode:'synchronous_commit=remote_apply; synchronous streaming standby ei_standby',
    sampleSize:rows,acknowledgedTransactions:rows,
    primaryKilledBySignal:'SIGKILL',standbyPromoted:true,
    durableRowsAfterPromotion:confirmed.length,missingIds:missing,mutatedRows:modified.map(x=>x.id),
    lostAcknowledgedTransactions:missing.length,measuredRpoTransactions:missing.length,
    measuredRtoMs:Math.round(measuredRtoMs*1000)/1000,rtoBudgetMs:maxRtoMs,
    postPromotionWriteSucceeded:last?.payload_sha256==='post-promotion-write',
    productionSloCertified:false,productionHaCertified:false,
    limitations:[
      'single GitHub Actions host, no cross-zone failover',
      'only acknowledged remote_apply commits covered by measured zero transaction loss',
      'not an Event Intelligence worker/receipt reconciliation under failover',
      'no remote provider/host or external end-to-end SLO',
      'no network partition / split-brain / standby promotion operator fencing verification',
    ],
  };
  await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  if(missing.length || modified.length || !report.postPromotionWriteSucceeded ||
      measuredRtoMs>=maxRtoMs) FAIL('failed-data-recovery-or-rto-budget');
  console.log(JSON.stringify({schema:report.schema,status:'passed',
    acknowledged:rows,rpoTransactions:0,measuredRtoMs:report.measuredRtoMs,
    sourceCommitSha,productionHaCertified:false}));
} finally {
  await Promise.allSettled([primary.end(),standby.end()]);
}
