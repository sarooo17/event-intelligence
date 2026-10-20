import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOwnerReadGuard } from '../scripts/lib/mcp-owner-read-guard.mjs';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';

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

// JSON.stringify(Error) hides non-enumerable message/stack and often nested
// Error causes. The negative oracle must inspect descriptors recursively,
// without invoking getters or looping forever on cyclic cause chains.
function errorDiagnostics(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  return Reflect.ownKeys(value).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return String(key) + ':' +
      ('value' in descriptor
        ? errorDiagnostics(descriptor.value, seen)
        : '[accessor]');
  }).join('|');
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
  assert.equal(listed,2,
    'a final authorization denial is already safe and must NOT be queried again');
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


test('failed wake hydration cannot leak builder error after cross-owner revocation', async () => {
  const triggerId = 'shared-name', matchId = 'revoked-wake-match';
  let currentOwner = alice, entered, release, lookups = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const guard = createOwnerReadGuard({
    owner: alice,
    triggerControl: {
      async listTriggers({ owner }) {
        lookups++;
        return sameIdentity(owner, currentOwner)
          ? [{definition:{triggerId,version:'1'},state:{owner:currentOwner}}]
          : [];
      },
    },
    store: {
      async latestWake() {
        return {subscriptionId:'trigger:shared-name',sourceEventId:matchId};
      },
      async getWakeDelivery() {
        return {matchId,triggerId,triggerVersion:'1'};
      },
      async listTriggerMatches() {
        return [{matchId,triggerId,triggerVersion:'1'}];
      },
    },
  });
  const pending = guard.withAuthorizedWakeResult('wake-revoked-error', async () => {
    entered();
    await blocked;
    // This error would be serialized by stdio errorResult() unless the
    // owner guard replaces it with nondisclosing not-found after revocation.
    throw new Error('SECRET-TENANT-A-PAYLOAD-IN-EXCEPTION');
  });
  await started;
  currentOwner = bob;
  release();
  await assert.rejects(pending, error => {
    notVisible(error);
    const diagnostics = errorDiagnostics(error);
    assert.equal(diagnostics.includes('SECRET-TENANT-A-PAYLOAD'), false);
    return true;
  });
  assert.equal(lookups, 3,
    'owner must be checked after a builder REJECTION as well as success');
});

test('failed inspector cannot leak builder exception across tenant reassignment', async () => {
  let currentOwner = alice, entered, release, lookups = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const guard = createOwnerReadGuard({
    owner: alice,
    triggerControl:{
      async listTriggers({owner}) {
        lookups++;
        return sameIdentity(owner,currentOwner)
          ? [{definition:{triggerId:'shared-name',version:'1'},state:{owner:currentOwner}}]
          : [];
      },
    },
    store:{
      async latestWake(){return null;},
      async listTriggerMatches(){return [];},
    },
  });
  const pending = guard.withAuthorizedTriggerResult('shared-name','1',async()=>{
    entered();
    await blocked;
    throw new Error('SECRET-FROM-OTHER-TENANT-INSPECTOR');
  });
  await started;
  currentOwner = aliceOtherTenant;
  release();
  await assert.rejects(pending, error => {
    notVisible(error);
    assert.equal(errorDiagnostics(error)
      .includes('SECRET-FROM-OTHER-TENANT'),false);
    return true;
  });
  assert.equal(lookups,2,'failed inspector needs post-failure owner check');
});

test('builder errors remain visible to current owner when authorization is unchanged', async () => {
  const {guard} = fixture({
    wake:{subscriptionId:'trigger:shared-name',sourceEventId:'match-owned'},
    delivery:{matchId:'match-owned',triggerId:'shared-name',triggerVersion:'1'},
    match:{matchId:'match-owned',triggerId:'shared-name',triggerVersion:'1'},
  });
  const permittedFailure = new Error('owned builder service unavailable');
  await assert.rejects(
    () => guard.withAuthorizedWakeResult('wake-owned-error',
      async () => { throw permittedFailure; }),
    error => error === permittedFailure,
  );
  await assert.rejects(
    () => guard.withAuthorizedTriggerResult('shared-name','1',
      async () => { throw permittedFailure; }),
    error => error === permittedFailure,
  );
});


test('failed matched-evidence read cannot return sensitive error after revocation', async () => {
  let ownerNow = alice, entered, release, checks = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const guard = createOwnerReadGuard({
    owner:alice,
    triggerControl:{
      async listTriggers({owner}) {
        checks++;
        return sameIdentity(owner,ownerNow)
          ? [{definition:{triggerId:'shared-name',version:'1'},state:{owner:ownerNow}}]
          : [];
      },
    },
    store:{
      async latestWake() {
        return {subscriptionId:'trigger:shared-name',sourceEventId:'match-error'};
      },
      async getWakeDelivery() {
        return {matchId:'match-error',triggerId:'shared-name',triggerVersion:'1'};
      },
      async listTriggerMatches() {
        entered();
        await gate;
        throw new Error('SECRET-PROVIDER-EVIDENCE-IN-DATABASE-ERROR');
      },
    },
  });
  const pending = guard.assertWake('wake-error-evidence');
  await started;
  ownerNow = bob;
  release();
  await assert.rejects(pending,error=>{
    notVisible(error);
    assert.equal(errorDiagnostics(error).includes('SECRET-PROVIDER-EVIDENCE'),false);
    return true;
  });
  assert.equal(checks,2,'failed post-auth evidence read must recheck pinned owner');
});

test('matched-evidence service error is preserved while original owner retains access', async()=>{
  const secret = new Error('owned PostgreSQL read interrupted');
  const guard=createOwnerReadGuard({
    owner:alice,
    triggerControl:{
      async listTriggers({owner}) {
        return sameIdentity(owner,alice)
          ? [{definition:{triggerId:'shared-name',version:'1'},state:{owner:alice}}]
          : [];
      },
    },
    store:{
      async latestWake() {
        return {subscriptionId:'trigger:shared-name',sourceEventId:'m'};
      },
      async getWakeDelivery() {
        return {matchId:'m',triggerId:'shared-name',triggerVersion:'1'};
      },
      async listTriggerMatches(){throw secret;},
    },
  });
  await assert.rejects(()=>guard.assertWake('wake-owned-service-error'),
    error=>error===secret);
});


test('negative error-leak oracle detects nested and non-enumerable Error causes',()=>{
  const nested = new Error('top-level innocuous', {
    cause: new Error('SECRET-TENANT-A-PAYLOAD'),
  });
  Object.defineProperty(nested,'privateDiagnostic',{
    configurable:true,enumerable:false,
    value:{ inner: new Error('SECRET-FROM-OTHER-TENANT') },
  });
  const observable = errorDiagnostics(nested);
  assert.match(observable,/SECRET-TENANT-A-PAYLOAD/);
  assert.match(observable,/SECRET-FROM-OTHER-TENANT/);
  assert.match(observable,/stack:/);
  nested.cause.cause = nested;
  assert.match(errorDiagnostics(nested),/\[circular\]/);
});


test('wake with missing durable producer version is denied BEFORE any evidence read', async()=>{
  const matchId='v1-private-match',triggerId='shared-name';
  for (const mode of ['missing-method','missing-record','missing-version']) {
    let reads=0;
    const store={
      async latestWake() {
        return {subscriptionId:'trigger:'+triggerId,sourceEventId:matchId};
      },
      async listTriggerMatches(){
        reads++;
        throw new Error('SECRET-V1-MATCH-EVIDENCE');
      },
      ...(mode==='missing-record' ? {async getWakeDelivery(){return null;}} : {}),
      ...(mode==='missing-version' ? {async getWakeDelivery(){
        return {matchId,triggerId,triggerVersion:''};
      }} : {}),
    };
    const guard=createOwnerReadGuard({
      owner:alice,
      triggerControl:{
        async listTriggers({owner}){
          // The caller retains v2, while the wake may have originated from
          // transferred v1; a latest-owned-version fallback would be unsafe.
          return sameIdentity(owner,alice)
            ? [{definition:{triggerId,version:'2'},state:{owner:alice}}]
            : [];
        },
      },
      store,
    });
    await assert.rejects(()=>guard.assertWake('v1-unpinned'),notVisible);
    assert.equal(reads,0,'unversioned wake must never read evidence: '+mode);
  }
});

test('final owner denial cannot be replaced by a third authorization query error',async()=>{
  let lookups=0, revoke;
  const released=new Promise(resolve=>{revoke=resolve;});
  const guard=createOwnerReadGuard({
    owner:alice,
    triggerControl:{
      async listTriggers({owner}){
        lookups++;
        if (lookups>=3) throw new Error('SECRET-AUTH-BACKEND-ERROR');
        if(lookups===2) return [];
        return [{definition:{triggerId:'shared-name',version:'1'},state:{owner:alice}}];
      },
    },
    store:{
      async latestWake() {
        return {subscriptionId:'trigger:shared-name',sourceEventId:'m'};
      },
      async getWakeDelivery() {
        return {matchId:'m',triggerId:'shared-name',triggerVersion:'1'};
      },
      async listTriggerMatches() {
        revoke();
        return [{matchId:'m',triggerId:'shared-name',triggerVersion:'1'}];
      },
    },
  });
  await assert.rejects(()=>guard.assertWake('revoke-before-final-query'),error=>{
    notVisible(error);
    assert.equal(errorDiagnostics(error).includes('SECRET-AUTH-BACKEND'),false);
    return true;
  });
  await released;
  assert.equal(lookups,2,'must not re-query after definitive authorization denial');
});


test('JSONL restart must not fabricate version 1 for an unversioned legacy wake',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'ei-legacy-wake-version-'));
  try {
    const source=new PersistentEventStore(dir);
    await source.init();
    const id='legacy-unknown-version',matchId='legacy-match';
    await source.ensureWakeDelivery({
      wakeId:id,matchId,triggerId:'shared-name',triggerVersion:'1',
      runtime:'fixture',now:new Date().toISOString(),
    });
    const legacyRetry=await source.ensureWakeDelivery({
      wakeId:id,matchId,triggerId:'shared-name',runtime:'fixture',
      // Older caller retries a SAME known wake without producer version.
    });
    assert.equal(legacyRetry.triggerVersion,'1');
    const file=source.files.wakeDeliveries;
    const lines=(await readFile(file,'utf8')).trim().split('\n');
    const legacy=JSON.parse(lines.at(-1));
    delete legacy.triggerVersion; // persisted pre-versioned record
    lines[lines.length-1]=JSON.stringify(legacy);
    await writeFile(file,lines.join('\n')+'\n','utf8');
    const restored=new PersistentEventStore(dir);
    await restored.init();
    const loaded=await restored.getWakeDelivery(id);
    assert.equal(loaded.triggerVersion,'',
      'missing producer version must remain unknown across JSONL restart');
    let evidenceReads=0;
    const guard=createOwnerReadGuard({
      owner:alice,
      triggerControl:{
        async listTriggers({owner}){
          return sameIdentity(owner,alice)
            ? [{definition:{triggerId:'shared-name',version:'2'},state:{owner:alice}}]
            : [];
        },
      },
      store:{
        async latestWake(){
          return {subscriptionId:'trigger:shared-name',sourceEventId:matchId};
        },
        getWakeDelivery:(wakeId)=>restored.getWakeDelivery(wakeId),
        async listTriggerMatches(){
          evidenceReads++;
          throw new Error('SECRET-LEGACY-MATCH-V1');
        },
      },
    });
    await assert.rejects(()=>guard.assertWake(id),notVisible);
    assert.equal(evidenceReads,0);
    await assert.rejects(()=>restored.ensureWakeDelivery({
      wakeId:'new-missing-version',matchId,triggerId:'shared-name',
      runtime:'fixture',
    }),/explicit triggerVersion/);
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});


test('missing-match nondisclosure cannot be overwritten by authorization backend failure',async()=>{
  let authorizationReads=0;
  const guard=createOwnerReadGuard({
    owner:alice,
    triggerControl:{
      async listTriggers(){
        authorizationReads++;
        if(authorizationReads>1) throw new Error('SECRET-AUTH-SERVICE-DETAIL');
        return [{definition:{triggerId:'shared-name',version:'1'},state:{owner:alice}}];
      },
    },
    store:{
      async latestWake(){
        return {subscriptionId:'trigger:shared-name',sourceEventId:'missing'};
      },
      async getWakeDelivery(){
        return {matchId:'missing',triggerId:'shared-name',triggerVersion:'1'};
      },
      async listTriggerMatches(){return [];},
    },
  });
  await assert.rejects(()=>guard.assertWake('nonexistent-wake-match'),error=>{
    notVisible(error);
    assert.equal(errorDiagnostics(error).includes('SECRET-AUTH-SERVICE'),false);
    return true;
  });
  assert.equal(authorizationReads,1,
    'missing match is a completed not-found decision, not an evidence-read failure');
});
