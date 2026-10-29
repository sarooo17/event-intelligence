import assert from 'node:assert/strict';
import test from 'node:test';
import { TriggerInspector } from '../scripts/lib/trigger-inspector.mjs';

const at='2026-10-29T11:00:00.000Z';
const definition={
  triggerId:'owned-trigger',version:'1',
  clauses:[{id:'a',event:'a',serverId:'provider'}],
  pattern:{root:{kind:'event',ref:'a'}},
  target:{runtime:'host',kind:'task',id:'one'},
};
const record={
  matchId:'wanted',triggerId:'owned-trigger',triggerVersion:'1',
  sourceEvents:[{clauseId:'a',serverId:'provider',
    sourceEventId:'event-a',eventName:'a',traceId:'trace-a',
    occurredAt:at,data:{secret:'not-output'}}],
  status:'partial',updatedAt:at,openedAt:at,expiresAt:null,
  patternState:null,firedWakeId:null,derivedEventIds:[],
};
function directStore(match=record,def=definition){
  const calls=[];
  return {
    calls,
    getTrigger:async(id,version)=>{calls.push('getTrigger');return id===def.triggerId&&version===def.version?def:null;},
    getTriggerMatch:async(id)=>{calls.push('getTriggerMatch');return id===match.matchId?match:null;},
    listTriggers:()=>{throw Error('forbidden whole-scope trigger scan');},
    listTriggerMatches:()=>{throw Error('forbidden whole-scope match scan');},
    getTriggerState:()=>({status:'active',fireCount:0}),
    getRecentTriggerMatchHistory:()=>({records:[],hasMore:false,limit:2}),
    listTemporalDeadlines:()=>[],
    listDerivedEvents:()=>[],
    latestWake:()=>null,
  };
}
test('explicit version and match use both keyed lookups, never scope-wide reads',async()=>{
  const store=directStore();
  const view=await new TriggerInspector({store,matchHistoryLimit:2,evidenceRefLimit:2})
    .inspect({triggerId:'owned-trigger',version:'1',matchId:'wanted'});
  assert.deepEqual(store.calls,['getTrigger','getTriggerMatch']);
  assert.equal(view.match.matchId,'wanted');
  assert.equal(view.diagnosis.sourceCertainty,'unverified');
  assert.equal(view.clauses[0].observedCount,1);
  assert.equal(JSON.stringify(view).includes('not-output'),false);
});
test('cross-trigger or cross-version match ID fails closed without reading evidence',async()=>{
  for (const wrong of [{...record,triggerId:'another-trigger'},
    {...record,triggerVersion:'2'}]){
    const store=directStore(wrong);
    await assert.rejects(()=>new TriggerInspector({store})
      .inspect({triggerId:'owned-trigger',version:'1',matchId:'wanted'}),
    error=>error?.code==='TRIGGER_MATCH_NOT_FOUND');
    assert.deepEqual(store.calls,['getTrigger','getTriggerMatch']);
  }
});
test('unknown version never launches a full-definition scan',async()=>{
  const store=directStore();
  await assert.rejects(()=>new TriggerInspector({store})
    .inspect({triggerId:'owned-trigger',version:'999',matchId:'wanted'}),
  error=>error?.code==='TRIGGER_NOT_FOUND');
  assert.deepEqual(store.calls,['getTrigger']);
});

test('ambiguous trigger ID/version delimiters cannot cross-read another definition',async()=>{
  const store=directStore();
  // Both original pairs map to the same legacy key alpha@beta@1.
  store.getTrigger=async()=>({...definition,triggerId:'alpha@beta',version:'1'});
  await assert.rejects(()=>new TriggerInspector({store})
    .inspect({triggerId:'alpha',version:'beta@1',matchId:'wanted'}),
  error=>error?.code==='TRIGGER_NOT_FOUND');
  assert.deepEqual(store.calls,[],'foreign match must never be fetched after misbound definition');
});
