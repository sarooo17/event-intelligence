// EI-maintained PostgreSQL host reference, *not* an EI SDK/policy engine.
// Host owns its users, organizations, teams, graph/agent resumes and
// atomic outbox. EI owns Pattern, future conditions, retry and wake identity.
import {
  createEventIntelligence,
  createActivationDispatcher,
  createDeterministicReceiptId,
} from 'mcp-event-intelligence/embedded';

const identifier=x=>typeof x==='string'&&x.length>0&&x.length<=160;
const allowedKind=x=>x==='agent'||x==='graph';
const allowedRuntime=x=>typeof x==='string'&&/^[a-z][a-z0-9-]{0,39}$/.test(x);
function tables(prefix){
  if(typeof prefix!=='string'||!/^[a-z][a-z0-9_]{2,29}$/.test(prefix))
    throw new TypeError('Host demo requires a safe, explicitly scoped tablePrefix');
  return {
    members:'"'+prefix+'_members"',
    targets:'"'+prefix+'_targets"',
    outbox:'"'+prefix+'_outbox"',
  };
}
function denied(){
  const e=new Error('Host continuation not authorized or revoked');
  e.code='HOST_GRAPH_TARGET_DENIED';return e;
}
const configError=()=>new TypeError('Explicit org/workspace, pool and host schema are required');

// Demo-only host DB schema. Real applications should use their own migrations
// and preserve their existing source of truth for membership and graph state.
export async function initializeOrgGraphExampleSchema(pool,prefix){
  const t=tables(prefix);
  if(typeof pool?.query!=='function')throw configError();
  await pool.query(`CREATE TABLE ${t.members} (
    org_id TEXT NOT NULL, team_id TEXT NOT NULL, user_id TEXT NOT NULL,
    active BOOLEAN NOT NULL, PRIMARY KEY(org_id,team_id,user_id)
  )`);
  await pool.query(`CREATE TABLE ${t.targets} (
    org_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
    target_id TEXT NOT NULL, runtime TEXT NOT NULL, kind TEXT NOT NULL,
    team_id TEXT NOT NULL, owner_id TEXT NOT NULL,
    active BOOLEAN NOT NULL,
    PRIMARY KEY(org_id,workspace_id,target_id)
  )`);
  await pool.query(`CREATE TABLE ${t.outbox} (
    receipt_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
    team_id TEXT NOT NULL, owner_id TEXT NOT NULL,
    target_id TEXT NOT NULL, runtime TEXT NOT NULL, kind TEXT NOT NULL,
    wake_id TEXT NOT NULL,
    UNIQUE(org_id,workspace_id,wake_id)
  )`);
  return Object.freeze({...t});
}

// Each org/workspace runtime is host-owned. Multiple instances may share
// one DB and independent worker pools while preserving distinct namespaces.
// EI does not create a new session or agent execution loop per individual agent.
export function createOrgGraphWakeRuntime({
  pool,tablePrefix,orgId,workspaceId,onCommitted,
}={}){
  const t=tables(tablePrefix);
  if(typeof pool?.query!=='function'||typeof pool?.connect!=='function'||
     !identifier(orgId)||!identifier(workspaceId)||
     (onCommitted!==undefined&&typeof onCommitted!=='function'))
    throw configError();
  const namespace='orggraph:'+JSON.stringify([orgId,workspaceId]);
  async function hasReceipt(receiptId,activation){
    const r=await pool.query(
      `SELECT org_id,workspace_id,target_id,runtime,kind,wake_id
       FROM ${t.outbox} WHERE receipt_id=$1`,[receiptId]);
    if(!r.rowCount)return false;
    const row=r.rows[0];
    if(row.org_id!==orgId||row.workspace_id!==workspaceId||
       row.target_id!==activation.target.id||
       row.runtime!==activation.target.runtime||
       row.kind!==activation.target.kind||
       row.wake_id!==activation.wake.wakeId)
      throw new Error('HOST_GRAPH_RECEIPT_COLLISION');
    return true;
  }
  async function resolveTarget(target){
    if(!identifier(target?.id)||!allowedKind(target?.kind)||
       !allowedRuntime(target?.runtime))return null;
    const result=await pool.query(
      `SELECT t.target_id,t.runtime,t.kind,t.team_id,t.owner_id
       FROM ${t.targets} t JOIN ${t.members} m
       ON m.org_id=t.org_id AND m.team_id=t.team_id AND m.user_id=t.owner_id
       WHERE t.org_id=$1 AND t.workspace_id=$2 AND t.target_id=$3
       AND t.runtime=$4 AND t.kind=$5
       AND t.active=TRUE AND m.active=TRUE`,
      [orgId,workspaceId,target.id,target.runtime,target.kind]);
    if(result.rowCount!==1)return null;
    return Object.freeze({...result.rows[0],orgId,workspaceId});
  }
  async function deliver({activation,target,receiptId}){
    // No authority from event.data, model text or a self-asserted scope.
    // Recheck target/membership UNDER ROW LOCK in the SAME PG transaction
    // that inserts the unique host outbox+receipt. Preflight isn't enough.
    const c=await pool.connect();
    let inserted=false;
    try{
      await c.query('BEGIN');
      const tr=await c.query(
        `SELECT runtime,kind,team_id,owner_id,active
         FROM ${t.targets} WHERE org_id=$1 AND workspace_id=$2
         AND target_id=$3 FOR UPDATE`,
        [orgId,workspaceId,activation.target.id]);
      if(tr.rowCount!==1)throw denied();
      const current=tr.rows[0];
      if(!current.active||current.runtime!==activation.target.runtime||
         current.kind!==activation.target.kind||
         current.team_id!==target.team_id||current.owner_id!==target.owner_id)
        throw denied();
      const member=await c.query(
        `SELECT active FROM ${t.members}
         WHERE org_id=$1 AND team_id=$2 AND user_id=$3 FOR UPDATE`,
        [orgId,current.team_id,current.owner_id]);
      if(member.rowCount!==1||member.rows[0].active!==true)
        throw denied();
      const result=await c.query(
        `INSERT INTO ${t.outbox}
         (receipt_id,org_id,workspace_id,team_id,owner_id,
         target_id,runtime,kind,wake_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT DO NOTHING RETURNING receipt_id`,
        [receiptId,orgId,workspaceId,current.team_id,current.owner_id,
         activation.target.id,current.runtime,current.kind,activation.wake.wakeId]);
      inserted=result.rowCount===1;
      if(!inserted){
        const existing=await c.query(
          `SELECT org_id,workspace_id,target_id,runtime,kind,wake_id
             FROM ${t.outbox} WHERE receipt_id=$1`,[receiptId]);
        if(existing.rowCount!==1||
           existing.rows[0].org_id!==orgId||
           existing.rows[0].workspace_id!==workspaceId||
           existing.rows[0].target_id!==activation.target.id||
           existing.rows[0].runtime!==activation.target.runtime||
           existing.rows[0].kind!==activation.target.kind||
           existing.rows[0].wake_id!==activation.wake.wakeId)
          throw new Error('HOST_GRAPH_RECEIPT_COLLISION');
      }
      await c.query('COMMIT');
    }catch(error){
      await c.query('ROLLBACK').catch(()=>{});
      throw error;
    }finally{
      c.release();
    }
    // Optional host acknowledgment channel. An error after COMMIT must
    // reconcile via readReceipt and must NOT insert a second host effect.
    if(onCommitted)await onCommitted({receiptId,inserted,orgId,workspaceId});
    return {runtimeReceiptId:receiptId,duplicate:!inserted};
  }
  return Object.freeze({
    receiptNamespace:namespace,
    hasReceipt,resolveTarget,deliver,
  });
}
export function createOrgGraphWakeDispatcher(options){
  return createActivationDispatcher(createOrgGraphWakeRuntime(options));
}

// Full EI integration remains the single canonical facade. Production EI
// shared-state should use a separately host-provisioned PostgreSQL EI store,
// not the application-owned demo outbox tables.
export async function createOrgGraphEventIntelligence({
  pool,tablePrefix,orgId,workspaceId,onCommitted,
  mcp,store,env={},
}={}){
  const runtime=createOrgGraphWakeRuntime({
    pool,tablePrefix,orgId,workspaceId,onCommitted,
  });
  const integration=await createEventIntelligence({
    runtime,...(mcp?{mcp}:{}),...(store?{store}:{}),env,
  });
  return Object.freeze({integration,runtime,close:()=>integration.close()});
}

export function expectedGraphReceiptId(orgId,workspaceId,wakeId){
  if(!identifier(orgId)||!identifier(workspaceId)||!identifier(wakeId))
    throw configError();
  return createDeterministicReceiptId(
    'orggraph:'+JSON.stringify([orgId,workspaceId]),wakeId);
}
