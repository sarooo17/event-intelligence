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
