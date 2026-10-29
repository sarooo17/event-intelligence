import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PatternAstV2DefinitionSchema,
  evaluatePatternV2,
} from '../dist/src/intelligenceProtocol/index.js';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';

function source(ref, id, at, data) {
  return {
    clauseId: ref,
    traceId: `semantic-cache-${id}`,
    sourceEventId: id,
    eventName: `${ref}.event`,
    occurredAt: at,
    provider: 'semantic-cache-test',
    serverId: 'test',
    subscriptionArguments: {},
    data,
  };
}

function definition() {
  return PatternAstV2DefinitionSchema.parse({
    version: '2',
    root: {
      kind: 'semantic',
      id: 'same-problem',
      refs: ['issue', 'mail'],
      instruction: 'Do these describe the same customer problem?',
      input: ['issue.title', 'mail.subject'],
      matchThreshold: 0.8,
      rejectThreshold: 0.2,
      uncertain: 'escalate',
      execution: {
        cache: true,
        timeoutMs: 1000,
        onUnavailable: 'error',
      },
      child: {
        kind: 'allOf',
        children: [
          { kind: 'event', ref: 'issue' },
          { kind: 'event', ref: 'mail' },
        ],
      },
    },
    partitionBy: [],
    selection: {
      overlap: 'disallow',
      afterMatch: 'skipPastLast',
      maxMatchesPerEvent: 10,
    },
    execution: {
      maxCandidates: 64,
      maxSemanticEvaluations: 4,
      maxBufferedEvents: 100,
    },
  });
}

function events() {
  return [
    source(
      'issue',
      'issue-1',
      '2026-09-30T10:00:00.000Z',
      { title: 'Payment for SINV-1 fails' },
    ),
    source(
      'mail',
      'mail-1',
      '2026-09-30T10:01:00.000Z',
      { subject: 'Cannot pay SINV-1' },
    ),
  ];
}

function storeCache(store) {
  return {
    get: (key) => store.getSemanticDecisionCache(key),
    set: (key, decision) =>
      store.putSemanticDecisionCache(key, decision),
  };
}

test('semantic decision cache survives evaluation passes and restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-semantic-cache-'));
  try {
    let calls = 0;
    const evaluator = {
      cacheIdentity: 'test-evaluator:model-v1',
      async evaluate() {
        calls += 1;
        return {
          evaluator: 'test/model-v1',
          probability: 0.97,
          metadata: { cost: 0.001 },
        };
      },
    };

    const firstStore = new PersistentEventStore(dir);
    await firstStore.init();

    const first = await evaluatePatternV2({
      definition: definition(),
      events: events(),
      evaluator,
      semanticCache: storeCache(firstStore),
      semanticCacheNamespace: 'trigger@1',
    });
    assert.equal(first.matches.length, 1);
    assert.equal(first.semanticEvaluations, 1);
    assert.equal(first.semanticCacheHits, 0);
    assert.equal(first.semanticCacheMisses, 1);
    assert.equal(calls, 1);
    assert.equal(firstStore.semanticDecisionCacheSize(), 1);

    const sameProcess = await evaluatePatternV2({
      definition: definition(),
      events: events(),
      evaluator,
      semanticCache: storeCache(firstStore),
      semanticCacheNamespace: 'trigger@1',
    });
    assert.equal(sameProcess.matches.length, 1);
    assert.equal(sameProcess.semanticEvaluations, 0);
    assert.equal(sameProcess.semanticCacheHits, 1);
    assert.equal(sameProcess.semanticCacheMisses, 0);
    assert.equal(calls, 1);

    await firstStore.close();

    const restartedStore = new PersistentEventStore(dir);
    const restored = await restartedStore.init();
    assert.equal(restored.semanticDecisionCache, 1);

    const afterRestart = await evaluatePatternV2({
      definition: definition(),
      events: events(),
      evaluator,
      semanticCache: storeCache(restartedStore),
      semanticCacheNamespace: 'trigger@1',
    });
    assert.equal(afterRestart.semanticEvaluations, 0);
    assert.equal(afterRestart.semanticCacheHits, 1);
    assert.equal(calls, 1);

    const changedModel = {
      cacheIdentity: 'test-evaluator:model-v2',
      async evaluate() {
        calls += 1;
        return {
          evaluator: 'test/model-v2',
          probability: 0.96,
        };
      },
    };
    const modelUpgrade = await evaluatePatternV2({
      definition: definition(),
      events: events(),
      evaluator: changedModel,
      semanticCache: storeCache(restartedStore),
      semanticCacheNamespace: 'trigger@1',
    });
    assert.equal(modelUpgrade.semanticEvaluations, 1);
    assert.equal(modelUpgrade.semanticCacheMisses, 1);
    assert.equal(calls, 2);

    const revision = await evaluatePatternV2({
      definition: definition(),
      events: events(),
      evaluator,
      semanticCache: storeCache(restartedStore),
      semanticCacheNamespace: 'trigger@2',
    });
    assert.equal(revision.semanticEvaluations, 1);
    assert.equal(revision.semanticCacheMisses, 1);
    assert.equal(calls, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('evaluators without cacheIdentity never use durable cache', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-semantic-cache-unsafe-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    let calls = 0;
    const evaluator = {
      async evaluate() {
        calls += 1;
        return {
          evaluator: 'anonymous',
          probability: 0.9,
        };
      },
    };

    for (let i = 0; i < 2; i += 1) {
      const result = await evaluatePatternV2({
        definition: definition(),
        events: events(),
        evaluator,
        semanticCache: storeCache(store),
        semanticCacheNamespace: 'trigger@1',
      });
      assert.equal(result.matches.length, 1);
      assert.equal(result.semanticEvaluations, 1);
    }

    assert.equal(calls, 2);
    assert.equal(store.semanticDecisionCacheSize(), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('host-owned semantic context revision and TTL windows invalidate persisted decisions across restart', async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ei-semantic-revision-ttl-'));
  let store=new PersistentEventStore(dir);
  let calls=0;
  const evaluator={
    cacheIdentity:'vendor-neutral-model-v1',
    async evaluate(){
      calls++;
      return {evaluator:'vendor-neutral-model-v1',probability:0.99};
    },
  };
  const run=async({tenant='tenant-a',revision='policy-v1',at='2026-10-29T10:00:00.000Z'}={})=>
    evaluatePatternV2({
      definition:definition(),events:events(),evaluator,
      semanticCache:storeCache(store),
      semanticCacheNamespace:tenant+':trigger@1',
      semanticContextRevision:revision,semanticCacheTtlMs:60000,
      now:new Date(at),
    });
  try{
    await store.init();
    assert.equal((await run()).semanticEvaluations,1);
    assert.equal(calls,1);
    const hit=await run({at:'2026-10-29T10:00:59.000Z'});
    assert.equal(hit.semanticEvaluations,0);
    assert.equal(hit.semanticCacheHits,1);
    await store.close();
    store=new PersistentEventStore(dir);await store.init();
    assert.equal((await run({at:'2026-10-29T10:00:59.000Z'}))
      .semanticEvaluations,0,'revision and TTL cache survives JSONL restart');
    assert.equal((await run({revision:'policy-v2'})).semanticEvaluations,1);
    assert.equal((await run({tenant:'tenant-b'})).semanticEvaluations,1);
    assert.equal((await run({at:'2026-10-29T10:01:00.000Z'}))
      .semanticEvaluations,1,'TTL bucket change refuses an earlier cached decision');
    assert.equal(calls,4);
    assert.equal((await run({at:'2026-10-29T10:01:20.000Z'}))
      .semanticEvaluations,0);
    assert.equal(calls,4);
  }finally{
    await store.close();
    await rm(dir,{recursive:true,force:true});
  }
});

test('semantic cache TTL/revision rejects malformed options rather than silently reverting',async()=>{
  for(const ttl of [0,-1,100,86400001,1.2,NaN,'60000']){
    await assert.rejects(()=>evaluatePatternV2({
      definition:definition(),events:events(),semanticCacheTtlMs:ttl,
    }),/Invalid semantic context revision or cache TTL/);
  }
  for(const rev of [false,5,'r'.repeat(129)]){
    await assert.rejects(()=>evaluatePatternV2({
      definition:definition(),events:events(),semanticContextRevision:rev,
    }),/Invalid semantic context revision or cache TTL/);
  }
});
