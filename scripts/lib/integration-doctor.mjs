// Read-only host contract checks. This module does NOT call MCP registries,
// connect to a provider, open a store, alter cursors or deliver activations.
const validFunction = (value) => typeof value === 'function';

function check(id, status, message) {
  return Object.freeze({ id, status, message });
}

function report(checks, mode) {
  const totals = Object.freeze({
    pass: checks.filter((c) => c.status === 'pass').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    fail: checks.filter((c) => c.status === 'fail').length,
  });
  return Object.freeze({
    schema: 'event-intelligence.integration-doctor.v1',
    mode,
    status: totals.fail ? 'fail' : totals.warn ? 'warn' : 'pass',
    totals,
    checks: Object.freeze(checks),
  });
}

/**
 * Validate configuration shapes, not the runtime's live behavior.
 *
 * No callbacks are invoked; a PASS is NOT proof of a working MCP connection,
 * durable receipts or the host's authorization semantics.
 */
export function diagnoseEmbeddedConfiguration({
  mcp,
  runtime,
  storeCapabilities,
  requireSharedStore = false,
} = {}) {
  const checks = [];

  if (mcp === undefined) {
    checks.push(check(
      'mcp.registry',
      'warn',
      'No registry supplied; static MCP clients may be configured separately. Live source readiness not checked.',
    ));
  } else if (mcp && validFunction(mcp.list) &&
      (mcp.subscribe === undefined || validFunction(mcp.subscribe))) {
    checks.push(check('mcp.registry', 'pass', 'Host-owned MCP registry shape is valid; connections were not probed.'));
  } else {
    checks.push(check('mcp.registry', 'fail', 'Expected mcp.list() and optional mcp.subscribe().'));
  }

  if (runtime && validFunction(runtime.deliver)) {
    checks.push(check('runtime.delivery', 'pass', 'Host continuation delivery callback is configured; delivery not attempted.'));
  } else {
    checks.push(check('runtime.delivery', 'fail', 'Provide runtime.deliver() for host-owned continuation delivery.'));
  }

  if (runtime?.resolveContext !== undefined || runtime?.control !== undefined) {
    if (validFunction(runtime?.resolveContext) && validFunction(runtime?.control)) {
      checks.push(check('runtime.mutation-control', 'pass', 'Both context and host control callbacks are present; policy decisions not exercised.'));
    } else {
      checks.push(check('runtime.mutation-control', 'fail', 'Agent tools require both runtime.resolveContext() and runtime.control().'));
    }
  } else {
    checks.push(check('runtime.mutation-control', 'warn', 'Headless mode: no model-facing mutation tools will be exposed.'));
  }

  if (runtime?.receiptId && runtime?.receiptNamespace) {
    checks.push(check('runtime.receipt-identity', 'fail', 'Provide receiptId() or receiptNamespace, not both.'));
  } else if (runtime?.receiptId !== undefined &&
      !validFunction(runtime.receiptId)) {
    checks.push(check('runtime.receipt-identity', 'fail', 'runtime.receiptId must be a function.'));
  } else if (runtime?.receiptNamespace !== undefined &&
      (typeof runtime.receiptNamespace !== 'string' ||
        !runtime.receiptNamespace.trim())) {
    checks.push(check('runtime.receipt-identity', 'fail', 'runtime.receiptNamespace must be non-empty.'));
  } else {
    checks.push(check(
      'runtime.receipt-identity',
      runtime?.receiptId || runtime?.receiptNamespace ? 'pass' : 'warn',
      runtime?.receiptId || runtime?.receiptNamespace
        ? 'Deterministic receipt identity is configured.'
        : 'Provide a stable receiptId() or receiptNamespace for durable host idempotency.',
    ));
  }

  if (runtime?.hasReceipt !== undefined && !validFunction(runtime.hasReceipt)) {
    checks.push(check('runtime.receipt-reconciliation', 'fail', 'runtime.hasReceipt must be a function.'));
  } else {
    checks.push(check(
      'runtime.receipt-reconciliation',
      validFunction(runtime?.hasReceipt) ? 'pass' : 'warn',
      validFunction(runtime?.hasReceipt)
        ? 'Host receipt lookup is configured, but persistence was not verified.'
        : 'No hasReceipt() lookup configured; verify wake replay behavior before claiming effectively-once delivery.',
    ));
  }

  for (const key of ['resolveTarget', 'projectResult', 'projectError']) {
    if (runtime?.[key] !== undefined && !validFunction(runtime[key])) {
      checks.push(check(`runtime.${key}`, 'fail', `runtime.${key} must be a function.`));
    }
  }

  if (requireSharedStore) {
    const sharedReady =
      storeCapabilities?.sharedState === 'strong' &&
      storeCapabilities?.scopeIsolation === 'strong' &&
      storeCapabilities?.wakeClaims === 'distributed-atomic' &&
      storeCapabilities?.partitionLeases === 'distributed-atomic';
    checks.push(check(
      'store.shared',
      sharedReady ? 'pass' : 'fail',
      sharedReady
        ? 'Declared store capabilities satisfy the shared-mode shape. Actual DB safety not probed.'
        : 'Shared mode requires strong state and scope isolation plus distributed-atomic wake claims and partition leases.',
    ));
  } else {
    checks.push(check(
      'store.shared',
      'warn',
      'Shared-store readiness was not requested; verify storage mode separately for multi-worker deployments.',
    ));
  }

  return report(checks, 'embedded-contract');
}

/**
 * Offline CLI environment check. Never inspects environment variable values,
 * credentials, MCP sessions, stores or connected hosts.
 */
export function diagnoseEnvironment({
  nodeVersion = process.versions.node,
  env = process.env,
} = {}) {
  const checks = [];
  const major = Number(String(nodeVersion).split('.')[0]);
  checks.push(check(
    'node.version',
    Number.isInteger(major) && major >= 22 ? 'pass' : 'fail',
    Number.isInteger(major) && major >= 22
      ? 'Node.js runtime meets the declared >=22 requirement.'
      : 'Node.js >=22 is required.',
  ));

  const rawShared = env.EVENT_INTELLIGENCE_REQUIRE_SHARED_STORE;
  // Match the runtime's documented exact-string mode selection, but do not
  // silently treat a noncanonical value as disabled (e.g. "ture").
  const sharedSettingValid =
    rawShared === undefined || rawShared === '' ||
    rawShared === 'true' || rawShared === 'false';
  const shared = rawShared === 'true';
  const workerId = typeof env.EVENT_INTELLIGENCE_WORKER_ID === 'string' &&
    env.EVENT_INTELLIGENCE_WORKER_ID.trim().length > 0;
  checks.push(check(
    'store.shared-mode',
    !sharedSettingValid || (shared && !workerId) ? 'fail' : 'pass',
    !sharedSettingValid
      ? 'EVENT_INTELLIGENCE_REQUIRE_SHARED_STORE must be exactly "true" or "false" when set; invalid values are unsafe.'
      : shared
        ? workerId
          ? 'Shared mode and worker ID are configured; database/store contract was not checked.'
          : 'Shared mode requires EVENT_INTELLIGENCE_WORKER_ID; also provide a verified strong shared store.'
        : 'Shared store not explicitly required; multi-worker safety was not verified.',
  ));

  checks.push(check(
    'host.integration',
    'warn',
    'This offline CLI cannot inspect an embedding host. Use diagnoseEmbeddedConfiguration() with its callbacks and store capabilities; run host conformance for behavioral proof.',
  ));

  return report(checks, 'offline-environment');
}

export function formatDoctorReport(reportValue) {
  const lines = [`Event Intelligence doctor: ${reportValue.status.toUpperCase()} (${reportValue.mode})`];
  for (const row of reportValue.checks) {
    lines.push(`[${row.status.toUpperCase()}] ${row.id}: ${row.message}`);
  }
  lines.push('This is a non-mutating configuration check, not end-to-end runtime conformance.');
  return lines.join('\n');
}
