import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import {
  PATTERN_V2_SIGNATURE_FILE,
  PATTERN_V2_SIGNATURE_CONTRACT_VERSION,
} from '../scripts/lib/pattern-v2-signature-contract.mjs';

function trigger() {
  return {
    triggerId: 'persisted-v2', version: '1', conditionOnly: true,
    clauses: [{ id: 'a', event: 'invoice.opened', where: [], arguments: {} }],
    pattern: { version: '2', root: { kind: 'event', ref: 'a' } },
    withinMs: 60000,
  };
}
const incompatible = error =>
  error?.code === 'EVENT_INTELLIGENCE_PATTERN_V2_SIGNATURE_INCOMPATIBLE';

test('JSONL empty state is marked and compatible trigger survives a restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-v2-contract-current-'));
  try {
    const first = new PersistentEventStore(dir);
    await first.init();
    assert.equal(JSON.parse(await readFile(path.join(dir, PATTERN_V2_SIGNATURE_FILE))).version,
      PATTERN_V2_SIGNATURE_CONTRACT_VERSION);
    await first.putTrigger(trigger());
    await first.close();

    const second = new PersistentEventStore(dir);
    await second.init();
    assert.equal(second.listTriggers().length, 1);
    await second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('JSONL unmarked/unknown signature refuses existing Pattern v2 data without reset', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-v2-contract-legacy-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    await store.putTrigger(trigger());
    await store.close();
    const triggerFile = path.join(dir, 'triggers.jsonl');
    const original = await readFile(triggerFile, 'utf8');
    const marker = path.join(dir, PATTERN_V2_SIGNATURE_FILE);

    await rm(marker);
    await assert.rejects(new PersistentEventStore(dir).init(), incompatible);
    assert.equal(await readFile(triggerFile, 'utf8'), original);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });

    await writeFile(marker, JSON.stringify({
      component: 'pattern_v2_candidate_signature', version: 999,
    }) + '\n');
    await assert.rejects(new PersistentEventStore(dir).init(), incompatible);
    assert.equal(await readFile(triggerFile, 'utf8'), original);

    await writeFile(marker, '{not valid json');
    await assert.rejects(new PersistentEventStore(dir).init(), incompatible);
    assert.equal(await readFile(triggerFile, 'utf8'), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('JSONL orphan wake record cannot be silently adopted', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-v2-contract-wake-only-'));
  try {
    await writeFile(path.join(dir, 'wake-deliveries.jsonl'),
      JSON.stringify({
        wakeId: 'legacy-orphan', triggerId: 'deleted',
        matchId: 'old-match', runtime: 'host',
        status: 'delivered', runtimeReceiptId: 'old-receipt',
      }) + '\\n');
    await assert.rejects(new PersistentEventStore(dir).init(), incompatible);
    await assert.rejects(readFile(path.join(dir, PATTERN_V2_SIGNATURE_FILE)),
      { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('JSONL empty missing marker may adopt; orphan negative deadlines must not', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-v2-contract-orphan-'));
  try {
    await writeFile(path.join(dir, 'temporal-deadlines.jsonl'),
      JSON.stringify({ deadlineId: 'old-condition', triggerId: 'old',
        matchId: 'old-match', conditionId: 'old-signature',
        dueAt: '2026-10-18T00:00:00.000Z', status: 'pending' }) + '\n');
    await assert.rejects(new PersistentEventStore(dir).init(), incompatible);
    await assert.rejects(readFile(path.join(dir, PATTERN_V2_SIGNATURE_FILE)),
      { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
