// #353: separate OS-process host reference worker. Host authority and PG
// schema are supplied by trusted test operator, NOT event/packet scope.
import pg from 'pg';
import {createOrgGraphWakeDispatcher} from '../../examples/host-adapter/multi-org-graph-host.mjs';
const payload=JSON.parse(process.argv[2]??'null');
const {Pool}=pg;
async function main(){
  if(!payload || !process.env.POSTGRES_URL)throw Error('missing test config');
  const {tablePrefix,orgId,workspaceId,wakeId,target,
    crashAfterCommit=false,forgedScope=''}=payload;
  const pool=new Pool({connectionString:process.env.POSTGRES_URL,max:2});
  try{
    const activation={
      activationVersion:'2',
      wake:{wakeId,status:'queued',runtimeReceiptId:null,
        matchedAt:'2026-10-30T12:00:00.000Z'},
      target,
      trigger:{triggerId:'multi-org-trigger',version:'1',description:null,
        pattern:{version:'2',root:{kind:'event',ref:'event_1'},partitionBy:[],
          selection:{overlap:'disallow',afterMatch:'skipPastLast',maxMatchesPerEvent:10},
          execution:{maxCandidates:512,maxSemanticEvaluations:16,maxBufferedEvents:10000}},
        lifecycle:{oneShot:true,cooldownMs:0,completeOnGoal:false}},
      continuation:{instruction:'Host-controlled graph resume',
        contextPolicy:{evidence:'matched_events',maxEvents:20,includeData:true}},
      match:{matchId:'match-a',status:'matched',partitionKey:null,
        openedAt:'2026-10-30T12:00:00.000Z',
        updatedAt:'2026-10-30T12:00:00.000Z'},
      evidence:[],trust:{continuation:'configured_trigger_instruction',
        evidence:'untrusted_external_signal'},
    };
    const handler=createOrgGraphWakeDispatcher({
      pool,tablePrefix,orgId,workspaceId,
      ...(crashAfterCommit?{
        onCommitted:()=>{process.kill(process.pid,'SIGKILL');},
      }:{}),
    });
    const out=await handler({wake_id:wakeId,
      scope_id:forgedScope||orgId},activation);
    process.stdout.write(JSON.stringify({
      pid:process.pid,receiptId:out.runtimeReceiptId,
      duplicate:out.duplicate===true,
    })+'\n');
  }finally{
    await pool.end();
  }
}
main().catch(error=>{
  // Do not expose DB credentials/query inputs in error diagnostics.
  process.stderr.write(JSON.stringify({
    code:error?.code??'HOST_WORKER_FAILED',
  })+'\n');
  process.exitCode=2;
});