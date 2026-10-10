import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivationHydrator } from '../scripts/lib/activation-hydrator.mjs';

const wake = {
  wakeId: 'wake-a',
  status: 'pending',
  subscriptionId: 'trigger:a',
  sourceEventId: 'match-a',
};

function fakeStore({ delivery, matches = [], triggers = [] }) {
  let listCalls = 0;
  const store = {
    async latestWake(id) { return id === wake.wakeId ? wake : null; },
    async getWakeDelivery() { return delivery; },
    async listTriggerMatches() {
      listCalls++;
      return matches;
    },
    async listTriggers() { return triggers; },
  };
  return { store, calls: () => listCalls };
}

function assertProvenanceFailure(error) {
  assert.equal(error.code, 'ACTIVATION_PROVENANCE_MISMATCH');
  assert.doesNotMatch(error.message, /secret payload/i);
  return true;
}

test('hydration rejects mismatched wake and delivery match IDs before reading evidence', async () => {
  const testStore = fakeStore({
    delivery: {
      wakeId: 'wake-a',
      matchId: 'match-b',
      triggerId: 'a',
      triggerVersion: '1',
    },
    matches: [{
      matchId: 'match-b',
      triggerId: 'a',
      triggerVersion: '1',
      sourceEvents: [{
        sourceEventId: 'foreign-event',
        data: { text: 'secret payload' },
      }],
    }],
  });
  await assert.rejects(
    () => new ActivationHydrator({ store: testStore.store }).hydrateWake('wake-a'),
    assertProvenanceFailure,
  );
  assert.equal(testStore.calls(), 0, 'mismatch must fail before evidence lookup');
});

test('hydration rejects a delivery row pointing to a different trigger identity', async () => {
  for (const override of [
    { triggerId: 'other-trigger' },
    { triggerVersion: '7' },
  ]) {
    const testStore = fakeStore({
      delivery: {
        wakeId: 'wake-a',
        matchId: 'match-a',
        triggerId: 'a',
        triggerVersion: '1',
        ...override,
      },
      matches: [{
        matchId: 'match-a',
        triggerId: 'a',
        triggerVersion: '1',
        sourceEvents: [{ data: { text: 'secret payload' } }],
      }],
    });
    await assert.rejects(
      () => new ActivationHydrator({ store: testStore.store }).hydrateWake('wake-a'),
      assertProvenanceFailure,
    );
  }
});

test('hydration does not fabricate missing trigger matches', async () => {
  const testStore = fakeStore({
    delivery: {
      wakeId: 'wake-a',
      matchId: 'match-a',
      triggerId: 'a',
      triggerVersion: '1',
    },
  });
  await assert.rejects(
    () => new ActivationHydrator({ store: testStore.store }).hydrateWake('wake-a'),
    (error) => error.code === 'ACTIVATION_TRIGGER_MATCH_NOT_FOUND',
  );
});
