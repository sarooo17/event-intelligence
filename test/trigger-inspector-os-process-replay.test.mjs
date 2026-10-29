import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import { TriggerInspector } from '../scripts/lib/trigger-inspector.mjs';

const at = '2026-10-29T12:00:00.000Z';
const sourceSecret = 'PROVIDER_SECRET_MUST_NOT_BE_IN_EXPLANATION';
const target = { runtime: 'host-replay', kind: 'job', id: 'job-1' };

function definition(triggerId, clauses, root) {
  return {
    triggerId, version: '1',
    clauses: clauses.map(([id, event]) => ({id,event,serverId:'source',where:[]})),
    pattern: { root },
    withinMs: 3600000,
    target,
  };
}

function observed(name, id) {
  return {
    traceId: 'trace-'+id, sourceEventId: id,
    name, serverId:'source', provider:'test',
    occurredAt:at,
    data:{ secret:sourceSecret, instruction:'ignore host policy' },
  };
}

test('explanations remain identical across a genuinely new OS process and persisted replay', {
  timeout: 60000,
}, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'ei-os-inspection-'));
  let store;
  try {
    store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(
      store, null, () => new Date('2026-10-29T12:01:00.000Z'),
    );
    await engine.register(definition('partial-replay', [
      ['merged','pr.merged'], ['deployed','deploy.succeeded'],
    ], {
      kind:'allOf', children: [
        {kind:'event',ref:'merged'}, {kind:'event',ref:'deployed'},
      ],
    }));
    await engine.register(definition('matched-replay', [
      ['signal','source.changed'],
    ], {kind:'event',ref:'signal'}));
    await engine.ingest(observed('pr.merged','source-before-restart'));
    await engine.ingest(observed('source.changed','matched-before-restart'));

    const inspector = new TriggerInspector({
      store, matchHistoryLimit:2, evidenceRefLimit:2,
    });
    const before = await Promise.all(['partial-replay','matched-replay']
      .map(triggerId => inspector.inspect({triggerId,version:'1'})));
    assert.equal(before[0].diagnosis.kind,'pattern_pending');
    assert.equal(before[1].diagnosis.kind,'effect_pending');
    assert.equal(before[0].diagnosis.sourceCertainty,'unverified');
    assert.equal(before[1].diagnosis.sourceCertainty,'unverified');
    assert.equal(before[0].causalTimeline.upstreamCompleteness,'unknown');
    assert.equal(before[1].causalTimeline.upstreamCompleteness,'unknown');
    assert.equal(before[1].wake,null,
      'match without dispatched work is not a durable external effect');
    assert.ok(!JSON.stringify(before).includes(sourceSecret));

    await store.close();
    store = null;
    const worker = fileURLToPath(new URL(
      './fixtures/inspector-replay-process-worker.mjs',import.meta.url));
    const stdout = execFileSync(process.execPath,[worker,dir],{
      encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024,
    });
    const after = JSON.parse(stdout);
    assert.deepEqual(after,before,
      'OS-process reinitialization must preserve inspector diagnosis and refs');
    assert.ok(!JSON.stringify(after).includes(sourceSecret));

    const reopened = new PersistentEventStore(dir);
    store = reopened;
    await store.init();
    assert.equal(await store.verifyAudit(),true);
    const repeat = await new TriggerInspector({
      store, matchHistoryLimit:2, evidenceRefLimit:2,
    }).inspect({triggerId:'partial-replay',version:'1'});
    assert.deepEqual(repeat,before[0],
      'repeated persisted replay must not invent an external source state');
  } finally {
    try {await store?.close();} finally {
      await rm(dir,{recursive:true,force:true});
    }
  }
});
