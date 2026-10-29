import assert from 'node:assert/strict';
import test from 'node:test';
import {createObservabilityEmitter} from '../scripts/lib/observability.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createEventIntelligenceHost} from '../scripts/host-integration.mjs';

const candidates=Array.from({length:256},(_,i)=>
  'opaque-payload-'+(i*91871).toString(36)+'-no-marker-Xx');
test('default operational emitter never publishes unlabelled secrets across any free-text dimension',async()=>{
  const records=[];
  const emit=createObservabilityEmitter(v=>records.push(v),{
    now:()=>new Date('2026-10-29T12:00:00.000Z'),
  });
  for(const secret of candidates){
    assert.equal(await emit.emit({
      event:'ei.'+secret,
      component:secret,traceId:secret,scopeId:secret,triggerId:secret,
      matchId:secret,wakeId:secret,connectionId:secret,serverId:secret,
      eventName:secret,summary:secret,status:secret,nextAttemptAt:secret,
      timestamp:secret,error:new Error(secret),
      metadata:{
        note:secret,secret:'x',unknown:secret,
        nested:{comment:secret,rows:[secret,{description:secret}]},
      },
      attempt:3,
    }),true);
    const record=records.at(-1);
    assert.deepEqual(record,{
      schema:'event-intelligence.observability.v1',
      timestamp:'2026-10-29T12:00:00.000Z',
      level:'info',event:'ei.unknown',
      component:'event-intelligence',
      attempt:3,error:{message:'[diagnostic omitted]'},
    });
    assert.equal(Object.isFrozen(record),true);
    assert.ok(!JSON.stringify(record).includes(secret));
  }
  assert.equal(records.length,256);
});

test('known trusted events retain low-cardinality telemetry without event data',async()=>{
  const rows=[];
  const emit=createObservabilityEmitter(row=>rows.push(row));
  assert.equal(await emit.emit({
    event:'ei.wake.delivered',level:'warn',status:'delivered',
    attempt:2,traceId:'provider-private-text',metadata:{value:42},
    error:new Error('unlabelled-private-message'),
  }),true);
  assert.equal(rows[0].event,'ei.wake.delivered');
  assert.equal(rows[0].status,'delivered');
  assert.equal(rows[0].level,'warn');
  assert.equal(rows[0].attempt,2);
  assert.deepEqual(rows[0].error,{message:'[diagnostic omitted]'});
  assert.equal(rows[0].traceId,undefined);
  assert.equal(rows[0].metadata,undefined);
});

test('diagnostic text requires explicit opt-in and invalid modes fail closed',async()=>{
  assert.throws(()=>createObservabilityEmitter(()=>{},{
    privacyLevel:'unsafe',
  }),/privacyLevel/);
  const rows=[];
  const emit=createObservabilityEmitter(row=>rows.push(row),{
    privacyLevel:'diagnostic',
  });
  assert.equal(await emit.emit({
    event:'ei.private-mode',traceId:'trace-test',
    metadata:{note:'sensitive-opaque-diagnostic'},
  }),true);
  assert.equal(rows[0].event,'ei.private-mode');
  assert.equal(rows[0].metadata.note,'sensitive-opaque-diagnostic');
  assert.equal(rows[0].traceId,'trace-test');
});

test('default emitter never executes untrusted getters or proxy traps to suppress text',async()=>{
  let traps=0;
  const proxy=new Proxy({secret:'unlabelled-secret'},{
    get(){traps++;throw Error('no get')},
    ownKeys(){traps++;throw Error('no ownkeys')},
    getOwnPropertyDescriptor(){traps++;throw Error('no descriptor')},
  });
  const row={event:'ei.wake.queued',metadata:proxy};
  Object.defineProperty(row,'traceId',{
    enumerable:true,get(){traps++;throw Error('no getter')}
  });
  const records=[];
  const emit=createObservabilityEmitter(x=>records.push(x));
  assert.equal(await emit.emit(row),true);
  assert.equal(traps,0);
  assert.equal(records[0].traceId,undefined);
  assert.equal(records[0].metadata,undefined);
});

test('host and embedded runtime expose explicit private diagnostic opt-in',async()=>{
  const dataDir=await mkdtemp(path.join(tmpdir(),'ei-private-telemetry-'));
  try {
    const minimal=[];
    const host=await createEventIntelligenceHost({
      dataDir,
      observability:record=>minimal.push(record),
    });
    await host.close();
    assert.ok(minimal.some(x=>x.event==='ei.lifecycle.started'));
    assert.equal(minimal.some(x=>x.metadata!==undefined),false,
      'production host defaults must never export arbitrary metadata');
    const diagnostic=[];
    const optInHost=await createEventIntelligenceHost({
      dataDir,
      observability:record=>diagnostic.push(record),
      observabilityOptions:{privacyLevel:'diagnostic'},
    });
    await optInHost.close();
    const started=diagnostic.find(x=>x.event==='ei.lifecycle.started');
    assert.ok(started?.metadata?.restoredScopes,
      'diagnostic opt-in must reach the actual projecting runtime emitter');
  }finally{
    await rm(dataDir,{recursive:true,force:true});
  }
});
