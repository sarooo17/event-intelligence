import assert from 'node:assert/strict';
import test from 'node:test';
import {createOwnerReadGuard} from '../scripts/lib/mcp-owner-read-guard.mjs';

const owner={type:'user',principal_id:'actor-1',tenant_id:'tenant-a'};
const cases=[
  {type:'user',principal_id:'actor-1',tenant_id:'tenant-b'},
  {type:'user',principal_id:'actor-2',tenant_id:'tenant-a'},
  {type:'agent',principal_id:'actor-1',tenant_id:'tenant-a'},
  {type:'user',principal_id:'actor-1'},
  {type:'user',principal_id:'actor-1',tenant_id:''},
  {type:'user',principal_id:'actor-1',tenant_id:'TENANT-A'},
  {type:'user',principal_id:'actor-1',tenant_id:'tenant-a '},
  {type:'user',principal_id:'ACTOR-1',tenant_id:'tenant-a'},
  {},
  null,
];
const notFound=e=>e?.code==='EVENT_INTELLIGENCE_RESOURCE_NOT_FOUND' &&
  e?.message==='Resource not found for configured owner';

test('1000 adversarial owner/version/tenant combinations deny unauthorized reads even when a custom list adapter fails to filter',async()=>{
  let unauthorizedEvidenceReads=0;
  for(let i=0;i<1000;i++){
    const forged=cases[i%cases.length];
    const id='shared-id-'+Math.floor(i/10);
    const version=i%2?'2':'1';
    const guard=createOwnerReadGuard({
      owner,
      triggerControl:{
        // Deliberately violates the filtering contract. Guard must still
        // enforce ownership based on persisted state, including tenant.
        async listTriggers(){
          return [{definition:{triggerId:id,version},state:{owner:forged}}];
        },
      },
      store:{
        async latestWake(){
          return {subscriptionId:'trigger:'+id,sourceEventId:'secret-match'};
        },
        async getWakeDelivery(){
          return {matchId:'secret-match',triggerId:id,triggerVersion:version};
        },
        async listTriggerMatches(){
          unauthorizedEvidenceReads++;
          return [{matchId:'secret-match',triggerId:id,triggerVersion:version,
            sourceEvents:[{data:{private:'ATTACKER-CANARY-'+i}}]}];
        },
      },
    });
    await assert.rejects(()=>guard.assertTrigger(id,version),notFound);
    await assert.rejects(()=>guard.assertWake('wake-'+i),notFound);
    await assert.rejects(()=>guard.withAuthorizedTriggerResult(id,version,
      ()=>{throw Error('unauthorized builder executed')}),notFound);
  }
  assert.equal(unauthorizedEvidenceReads,0,
    'foreign wake evidence must not be fetched after forged owner/tenant');
});

test('cross-tenant same trigger ID with mixed returned versions selects only exact owner version',async()=>{
  const guard=createOwnerReadGuard({
    owner,
    triggerControl:{
      async listTriggers(){
        return [
          {definition:{triggerId:'shared',version:'9'},
            state:{owner:{...owner,tenant_id:'tenant-b'}}},
          {definition:{triggerId:'shared',version:'2'},state:{owner}},
          {definition:{triggerId:'shared',version:'10'},
            state:{owner:{...owner,principal_id:'actor-2'}}},
          {definition:{triggerId:'shared',version:'1'},state:{owner}},
        ];
      },
    },
    store:{async latestWake(){return null},async listTriggerMatches(){return []}},
  });
  const owned=await guard.assertTrigger('shared');
  assert.equal(owned.definition.version,'2');
  await assert.rejects(()=>guard.assertTrigger('shared','9'),notFound);
  await assert.rejects(()=>guard.assertTrigger('shared','10'),notFound);
  assert.equal((await guard.assertTrigger('shared','1')).definition.version,'1');
});

test('foreign owners never become authorized through mismatched falsy identity',async()=>{
  for(const candidate of [undefined,null,'',0,{},true]){
    const guard=createOwnerReadGuard({
      owner,
      triggerControl:{async listTriggers(){
        return [{definition:{triggerId:'r',version:'1'},
          state:{owner:{type:'user',principal_id:'actor-1',tenant_id:candidate}}}];
      }},
      store:{async latestWake(){return null},async listTriggerMatches(){return []}},
    });
    await assert.rejects(()=>guard.assertTrigger('r','1'),notFound);
  }
});

test('malicious owner getter or proxy cannot execute or leak through a different legitimate version',async()=>{
  const secret='UNLABELLED-FOREIGN-OWNER-SECRET';
  let reads=0;
  const getterOwner={principal_id:'actor-1',tenant_id:'tenant-b'};
  Object.defineProperty(getterOwner,'type',{
    enumerable:true,get(){reads++;throw Error(secret)},
  });
  const proxyOwner=new Proxy({type:'user',principal_id:'actor-1',tenant_id:'tenant-b'},{
    get(){reads++;throw Error(secret)},
    getOwnPropertyDescriptor(){reads++;throw Error(secret)},
  });
  const store={async latestWake(){return null},async listTriggerMatches(){return []}};
  const guard=createOwnerReadGuard({
    owner,store,triggerControl:{async listTriggers(){return [
      {definition:{triggerId:'shared',version:'1'},
        state:{owner:getterOwner}},
      {definition:{triggerId:'shared',version:'1a'},
        state:{owner:proxyOwner}},
      {definition:{triggerId:'shared',version:'2'},state:{owner}},
    ]}},
  });
  assert.equal((await guard.assertTrigger('shared','2')).definition.version,'2');
  await assert.rejects(()=>guard.assertTrigger('shared','1'),e=>{
    assert.equal(notFound(e),true);
    assert.ok(!e.message.includes(secret));
    return true;
  });
  await assert.rejects(()=>guard.assertTrigger('shared','1a'),notFound);
  assert.equal(reads,0);
});

test('hostile rows, arrays and foreign accessors fail closed without executing JavaScript',async()=>{
  let calls=0;
  const hostile=new Proxy({},{
    get(){calls++;throw Error('raw-external-payload')},
    getOwnPropertyDescriptor(){calls++;throw Error('raw-external-payload')},
  });
  for(const rows of [[hostile],new Proxy([],{
    getOwnPropertyDescriptor(){calls++;throw Error('raw-external-payload')},
  })]){
    const guard=createOwnerReadGuard({
      owner,
      triggerControl:{async listTriggers(){return rows}},
      store:{async latestWake(){return null},async listTriggerMatches(){return []}},
    });
    await assert.rejects(()=>guard.assertTrigger('foreign'),notFound);
  }
  assert.equal(calls,0);
});
