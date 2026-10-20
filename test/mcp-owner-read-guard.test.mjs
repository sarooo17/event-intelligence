import assert from 'node:assert/strict';
import test from 'node:test';
import { createOwnerReadGuard } from '../scripts/lib/mcp-owner-read-guard.mjs';

const alice = { type: 'user', principal_id: 'alice', tenant_id: 'tenant-a' };
const bob = { type: 'user', principal_id: 'bob', tenant_id: 'tenant-a' };
const aliceOtherTenant = {
  type: 'user', principal_id: 'alice', tenant_id: 'tenant-b',
};
const entries = [
  {
    definition: { triggerId: 'shared-name', version: '1' },
    state: { owner: alice },
  },
  {
    definition: { triggerId: 'bob-only', version: '1' },
    state: { owner: bob },
  },
  {
    definition: { triggerId: 'shared-name', version: '2' },
    state: { owner: bob },
  },
  {
    definition: { triggerId: 'other-tenant', version: '1' },
    state: { owner: aliceOtherTenant },
  },
];
const sameIdentity = (a,b) =>
  a.type === b.type && a.principal_id === b.principal_id &&
  (a.tenant_id ?? '') === (b.tenant_id ?? '');

function fixture({ wake, delivery, match } = {}) {
  const calls = { listed: 0, matches: 0, hydrated: 0 };
  const triggerControl = {
    async listTriggers({owner}) {
      calls.listed++;
      return entries.filter((entry) => sameIdentity(entry.state.owner, owner));
    },
  };
  const store = {
    async latestWake() { return wake ?? null; },
    async getWakeDelivery() { return delivery ?? null; },
    async listTriggerMatches(id) {
      calls.matches++;
      return match && match.triggerId === id ? [match] : [];
    },
  };
  return {
    guard: createOwnerReadGuard({ owner: alice, triggerControl, store }),
    calls,
  };
}

function notVisible(error) {
  assert.equal(error.code, 'EVENT_INTELLIGENCE_RESOURCE_NOT_FOUND');
  assert.equal(error.message, 'Resource not found for configured owner');
  return true;
}

test('trigger reads never reveal foreign owner or other-tenant definitions', async () => {
  const {guard} = fixture();
  assert.equal((await guard.assertTrigger('shared-name', '1')).definition.version, '1');
  for (const id of ['bob-only', 'other-tenant', 'missing']) {
    await assert.rejects(() => guard.assertTrigger(id), notVisible);
  }
  await assert.rejects(() => guard.assertTrigger('shared-name', '2'), notVisible);
});

test('wake hydration checks ownership before reading matched evidence', async () => {
  const {guard,calls} = fixture({
    wake: { subscriptionId: 'trigger:bob-only', sourceEventId: 'match-bob' },
    match: {
      matchId: 'match-bob', triggerId: 'bob-only', triggerVersion: '1',
    },
  });
  await assert.rejects(() => guard.assertWake('wake-bob'), notVisible);
  assert.equal(calls.matches, 0, 'must reject before touching foreign match evidence');
});

test('owned wake and matching delivery are accepted without exposing raw evidence', async () => {
  const {guard} = fixture({
    wake: { subscriptionId: 'trigger:shared-name', sourceEventId: 'match-1' },
    delivery: {
      matchId: 'match-1', triggerId: 'shared-name', triggerVersion: '1',
    },
    match: {
      matchId: 'match-1', triggerId: 'shared-name', triggerVersion: '1',
    },
  });
  assert.equal((await guard.assertWake('wake-alice')).matchId, 'match-1');
});

test('missing or cross-linked wake IDs fail indistinguishably', async () => {
  const variants = [
    {},
    { wake: { subscriptionId: 'foreign', sourceEventId: 'm' } },
    { wake: { subscriptionId: 'trigger:shared-name', sourceEventId: 'm' } },
    {
      wake: { subscriptionId: 'trigger:shared-name', sourceEventId: 'm' },
      delivery: { matchId: 'wrong', triggerId: 'shared-name', triggerVersion: '1' },
      match: { matchId: 'm', triggerId: 'shared-name', triggerVersion: '1' },
    },
    {
      wake: { subscriptionId: 'trigger:shared-name', sourceEventId: 'm' },
      delivery: { matchId: 'm', triggerId: 'bob-only', triggerVersion: '1' },
      match: { matchId: 'm', triggerId: 'shared-name', triggerVersion: '1' },
    },
    {
      wake: { subscriptionId: 'trigger:shared-name', sourceEventId: 'm' },
      delivery: { matchId: 'm', triggerId: 'shared-name', triggerVersion: '2' },
      match: { matchId: 'm', triggerId: 'shared-name', triggerVersion: '1' },
    },
  ];
  for (const data of variants) {
    await assert.rejects(
      () => fixture(data).guard.assertWake('attacker-id'),
      notVisible,
    );
  }
});

test('versionless owner inspection binds exactly to owned version, not global latest', async () => {
  const { guard } = fixture();
  const owned = await guard.assertTrigger('shared-name');
  assert.equal(owned.definition.version, '1');
  await assert.rejects(() => guard.assertTrigger('shared-name', '2'), notVisible);
});


test('wake hydration rechecks owner when transfer commits before final lookup begins', async () => {
  const triggerId = 'shared-name';
  const matchId = 'old-owner-match';
  let currentOwner = alice;
  let listed = 0;
  let entered, release;
  const reading = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const control = {
    async listTriggers({ owner }) {
      listed++;
      return sameIdentity(owner, currentOwner)
        ? [{ definition: { triggerId, version:'1' }, state:{owner:currentOwner} }]
        : [];
    },
  };
  const store = {
    async latestWake() {
      return { subscriptionId:'trigger:shared-name', sourceEventId:matchId };
    },
    async getWakeDelivery() {
      return { matchId, triggerId, triggerVersion:'1' };
    },
    async listTriggerMatches() {
      entered();
      await blocked;
      return [{ matchId, triggerId, triggerVersion:'1',
        sourceEvents:[{data:{secret:'OWNER-HANDOFF-PRIVATE'}}] }];
    },
  };
  const staleGuard = createOwnerReadGuard({owner:alice, triggerControl:control, store});
  const pending = staleGuard.assertWake('wake-under-transfer');
  await reading;
  currentOwner = bob;
  release();
  await assert.rejects(pending, error => {
    notVisible(error);
    const diagnostics = [
      error.message, error.stack, error.code,
      error.cause instanceof Error ? error.cause.message : error.cause,
      Object.getOwnPropertyDescriptors(error),
    ];
    assert.equal(JSON.stringify(diagnostics).includes('OWNER-HANDOFF-PRIVATE'),false,
      'secret must not occur in enumerable or non-enumerable error details');
    return true;
  });
  assert.equal(listed,2,'owner must be queried AGAIN after matched evidence lookup');
  const newGuard = createOwnerReadGuard({owner:bob,triggerControl:control,store});
  assert.equal((await newGuard.assertWake('wake-under-transfer')).matchId,matchId);
});

test('wake hydration rechecks tenant when transfer precedes final lookup', async () => {
  const triggerId='shared-name';
  let currentOwner=alice;
  let release, entered;
  const gate=new Promise(resolve=>{release=resolve;});
  const observed=new Promise(resolve=>{entered=resolve;});
  const guard=createOwnerReadGuard({
    owner:alice,
    triggerControl:{
      async listTriggers({owner}) {
        return sameIdentity(currentOwner,owner)
          ? [{definition:{triggerId,version:'1'},state:{owner:currentOwner}}]
          : [];
      },
    },
    store:{
      async latestWake(){return {subscriptionId:'trigger:shared-name',sourceEventId:'m'};},
      async getWakeDelivery(){return {matchId:'m',triggerId,triggerVersion:'1'};},
      async listTriggerMatches(){
        entered();
        await gate;
        return [{matchId:'m',triggerId,triggerVersion:'1'}];
      },
    },
  });
  const pending=guard.assertWake('wake-same-principal-other-tenant');
  await observed;
  currentOwner=aliceOtherTenant;
  release();
  await assert.rejects(pending,notVisible);
});


test('wake envelope is denied when owner transfer commits during asynchronous hydration', async () => {
  const triggerId='shared-name', matchId='match-secret';
  let currentOwner=alice, listCalls=0, buildCalled=0;
  let entered, release;
  const started=new Promise(resolve=>{entered=resolve;});
  const blocked=new Promise(resolve=>{release=resolve;});
  const guard=createOwnerReadGuard({
    owner:alice,
    triggerControl:{
      async listTriggers({owner}){
        listCalls++;
        return sameIdentity(owner,currentOwner)
          ? [{definition:{triggerId,version:'1'},state:{owner:currentOwner}}]
          : [];
      },
    },
    store:{
      async latestWake(){return {subscriptionId:'trigger:shared-name',sourceEventId:matchId};},
      async getWakeDelivery(){return {matchId,triggerId,triggerVersion:'1'};},
      async listTriggerMatches(){
        return [{matchId,triggerId,triggerVersion:'1'}];
      },
    },
  });
  const envelope={evidence:{privateToken:'FORBIDDEN-AFTER-REVOKE'}};
  const work=guard.withAuthorizedWakeResult('wake-1', async () => {
    buildCalled++;
    entered();
    await blocked;
    return envelope;
  });
  await started;
  currentOwner=bob;
  release();
  await assert.rejects(work, error=>{
    notVisible(error);
    assert.equal(error.message.includes('FORBIDDEN-AFTER-REVOKE'),false);
    assert.equal(String(error.cause??'').includes('FORBIDDEN-AFTER-REVOKE'),false);
    return true;
  });
  assert.equal(buildCalled,1);
  assert.equal(listCalls,3,
    'initial wake-owner read, match-version read and final post-hydration check');
});

test('inspector result cannot escape after same-principal tenant transfer during inspection', async () => {
  const triggerId='shared-name';
  let currentOwner=alice, buildCalled=0;
  let entered, release;
  const started=new Promise(resolve=>{entered=resolve;});
  const blocked=new Promise(resolve=>{release=resolve;});
  const guard=createOwnerReadGuard({
    owner:alice,
    triggerControl:{
      async listTriggers({owner}){
        return sameIdentity(owner,currentOwner)
          ? [{definition:{triggerId,version:'1'},state:{owner:currentOwner}}]
          : [];
      },
    },
    store:{
      async latestWake(){return null;},
      async listTriggerMatches(){return [];},
    },
  });
  const pending=guard.withAuthorizedTriggerResult('shared-name','1',async (owned)=>{
    assert.equal(owned.definition.version,'1');
    buildCalled++;
    entered();
    await blocked;
    return {evidence:{secret:'FOREIGN-TENANT-INSPECT'}};
  });
  await started;
  currentOwner=aliceOtherTenant;
  release();
  await assert.rejects(pending,notVisible);
  assert.equal(buildCalled,1);
});

test('the final owner snapshot authorizes already-started reads, not retroactive cancellation',async()=>{
  const triggerId='shared-name', matchId='snapshot-read';
  let currentOwner=alice,lookups=0,finalCaptured,releaseFinal;
  const seen=new Promise(resolve=>{finalCaptured=resolve;});
  const pendingFinal=new Promise(resolve=>{releaseFinal=resolve;});
  const guard=createOwnerReadGuard({
    owner:alice,
    triggerControl:{
      async listTriggers({owner}){
        lookups++;
        const captured=sameIdentity(owner,currentOwner)
          ? [{definition:{triggerId,version:'1'},state:{owner:currentOwner}}]
          : [];
        if(lookups===3){
          finalCaptured();
          await pendingFinal;
        }
        return captured;
      },
    },
    store:{
      async latestWake(){return {subscriptionId:'trigger:shared-name',sourceEventId:matchId};},
      async getWakeDelivery(){return {matchId,triggerId,triggerVersion:'1'};},
      async listTriggerMatches(){return [{matchId,triggerId,triggerVersion:'1'}];},
    },
  });
  const pending=guard.withAuthorizedWakeResult('wake-snapshot',async()=>({id:'authorized-before-revocation'}));
  await seen;
  // Owner transfer commits AFTER the last owner-query snapshot. Current
  // contract permits already-authorized reads to complete; issue #235
  // still needs an atomic fence if stronger cancellation is desired.
  currentOwner=bob;
  releaseFinal();
  assert.deepEqual(await pending,{id:'authorized-before-revocation'});
  await assert.rejects(
    ()=>guard.withAuthorizedWakeResult('wake-snapshot',async()=>({secret:'no'})),
    notVisible,
  );
});
