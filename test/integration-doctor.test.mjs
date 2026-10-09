import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  diagnoseEmbeddedConfiguration,
  diagnoseEnvironment,
  formatDoctorReport,
} from '../scripts/lib/integration-doctor.mjs';

test('configuration doctor does not execute host functions or touch providers', () => {
  let called = 0;
  const unexpected = () => {
    called += 1;
    throw new Error('should not execute');
  };
  const result = diagnoseEmbeddedConfiguration({
    mcp: { list: unexpected, subscribe: unexpected },
    runtime: {
      deliver: unexpected,
      resolveContext: unexpected,
      control: unexpected,
      receiptNamespace: 'demo-host',
      hasReceipt: unexpected,
    },
    storeCapabilities: {
      sharedState: 'strong',
      scopeIsolation: 'strong',
      wakeClaims: 'distributed-atomic',
      partitionLeases: 'distributed-atomic',
    },
    requireSharedStore: true,
  });
  assert.equal(result.status, 'pass');
  assert.equal(result.checks.some((x) => x.id === 'store.shared' && x.status === 'pass'), true);
  assert.equal(called, 0);
});

test('doctor refuses missing mutation gate and weak distributed storage', () => {
  const result = diagnoseEmbeddedConfiguration({
    mcp: { list: () => [] },
    runtime: {
      deliver: () => undefined,
      resolveContext: () => ({}),
      hasReceipt: 'not-a-function',
      receiptId: () => 'receipt',
      receiptNamespace: 'both',
    },
    requireSharedStore: true,
    storeCapabilities: {
      sharedState: 'process',
      scopeIsolation: 'process',
    },
  });
  assert.equal(result.status, 'fail');
  const bad = result.checks.filter((x) => x.status === 'fail').map((x) => x.id);
  assert.ok(bad.includes('runtime.mutation-control'));
  assert.ok(bad.includes('runtime.receipt-identity'));
  assert.ok(bad.includes('runtime.receipt-reconciliation'));
  assert.ok(bad.includes('store.shared'));
});

test('headless diagnostics truthfully warn about unverifiable behavior', () => {
  const r = diagnoseEmbeddedConfiguration({
    runtime: { deliver: () => undefined },
  });
  assert.equal(r.status, 'warn');
  assert.match(formatDoctorReport(r), /not end-to-end runtime conformance/i);
  assert.deepEqual(r.totals, {
    pass: 1,
    warn: 5,
    fail: 0,
  });
});

test('offline doctor validates worker settings without leaking environment values', () => {
  const r = diagnoseEnvironment({
    nodeVersion: '22.4.0',
    env: {
      EVENT_INTELLIGENCE_REQUIRE_SHARED_STORE: 'true',
      EVENT_INTELLIGENCE_WORKER_ID: '',
      SECRET_TOKEN: 'should never appear',
    },
  });
  assert.equal(r.status, 'fail');
  assert.equal(r.checks.find((c) => c.id === 'store.shared-mode').status, 'fail');
  assert.doesNotMatch(JSON.stringify(r), /should never appear/);
});

test('CLI doctor --json is standalone and strictly offline', () => {
  const cli = new URL('../bin/mcp-event-intelligence.mjs', import.meta.url);
  const r = spawnSync(process.execPath, [cli.pathname, 'doctor', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      EVENT_INTELLIGENCE_REQUIRE_SHARED_STORE: 'false',
    },
  });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.schema, 'event-intelligence.integration-doctor.v1');
  assert.equal(parsed.mode, 'offline-environment');
  assert.equal(parsed.status, 'warn');
  assert.equal(r.stderr, '');
});

test('doctor rejects all noncanonical shared-mode values instead of silently disabling HA', () => {
  for (const invalid of ['ture', 'TRUE', 'False', '1', 'yes', ' true ', 'off']) {
    const result = diagnoseEnvironment({
      nodeVersion: '22.0.0',
      env: {
        EVENT_INTELLIGENCE_REQUIRE_SHARED_STORE: invalid,
        EVENT_INTELLIGENCE_WORKER_ID: 'worker-1',
      },
    });
    assert.equal(result.status, 'fail', invalid);
    const row = result.checks.find((entry) =>
      entry.id === 'store.shared-mode'
    );
    assert.equal(row.status, 'fail', invalid);
    assert.match(row.message, /must be exactly/);
    assert.equal(row.message.includes(invalid), false);
  }

  for (const valid of ['true', 'false', '', undefined]) {
    const r = diagnoseEnvironment({
      nodeVersion: '22.0.0',
      env: {
        EVENT_INTELLIGENCE_REQUIRE_SHARED_STORE: valid,
        EVENT_INTELLIGENCE_WORKER_ID: 'worker-1',
      },
    });
    assert.equal(r.checks.find((c) => c.id === 'store.shared-mode').status, 'pass');
  }
});
