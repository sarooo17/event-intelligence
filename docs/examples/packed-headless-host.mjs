#!/usr/bin/env node
// Headless, host-owned runtime demonstration from an installed npm package.
// No model, user-facing model tools, provider credential or external network.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEventIntelligence } from 'mcp-event-intelligence/embedded';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ei-packed-headless-'));
const env = {
  TYPESAFE_API_KEY: '',
  RUNTIME_WAKE_TARGETS_JSON: '{}',
  TEMPORAL_TICK_MS: '100000',
  WAKE_RETRY_TICK_MS: '100000',
};
let wakes = 0;
const options = {
  dataDir, env,
  mcp: { list: () => [] },
  runtime: {
    receiptNamespace: 'headless-consumer',
    deliver: () => {
      wakes += 1;
      return { runtimeReceiptId: 'host-owned' };
    },
  },
};
let first;
let second;
try {
  first = await createEventIntelligence(options);
  assert.equal(first.tools.length, 0);
  assert.equal(first.toolCatalog.all.length, 0);
  assert.equal((await first.diagnostics()).errors, 0);
  assert.deepEqual(await first.host.store.listTriggers(), []);
  await first.close();
  first = null;

  second = await createEventIntelligence(options);
  assert.equal(second.tools.length, 0);
  assert.equal((await second.diagnostics()).errors, 0);
  assert.deepEqual(await second.host.store.listTriggers(), []);
  assert.equal(wakes, 0);
  console.log(JSON.stringify({
    schema: 'event-intelligence.packed-headless-example.v1',
    status: 'pass',
    restarts: 1,
    tools: second.tools.length,
    wakes,
    providerConnections: 0,
  }));
} finally {
  try {
    await first?.close();
    await second?.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}
