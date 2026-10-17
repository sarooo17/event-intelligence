import {
  REQUIRED_EVENT_STORE_METHODS,
  validateSharedStoreCapabilities,
} from './store-capabilities.mjs';

/**
 * Minimum versioned *declarative* host integration contract. Requirements
 * must be grounded in actual supplied boundary callbacks, not self-reported
 * capability flags. It does not connect MCP, open storage or grant authority.
 */
export const HOST_CONTRACT_VERSION = '1';
export const HOST_CONTRACT_CAPABILITIES = Object.freeze([
  'mcp.registry',
  'storage.durable',
  'storage.shared',
  'wake.receipts',
  'tooling.owner-scoped',
  'semantic.evaluate',
  'observability.sink',
]);
const KNOWN = new Set(HOST_CONTRACT_CAPABILITIES);

function contractError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function configuredDurability({ store, dataDir, env }) {
  if (store !== undefined) {
    return store !== null && typeof store === 'object' &&
      REQUIRED_EVENT_STORE_METHODS.every(method =>
        typeof store[method] === 'function');
  }
  // Match the actual host env merge: process.env, overridden by caller env,
  // then by explicit dataDir when nonblank. This is a non-I/O shape check.
  const effectiveDir = dataDir ||
    (env && Object.hasOwn(env, 'DATA_DIR') ? env.DATA_DIR : process.env.DATA_DIR);
  return typeof effectiveDir === 'string' && Boolean(effectiveDir.trim());
}

function configuredSharedStore(store) {
  if (!configuredDurability({ store }) ||
      typeof store.storeCapabilities !== 'function') return false;
  try {
    return validateSharedStoreCapabilities(store).ok;
  } catch {
    // A misbehaving host capability-descriptor callback cannot escape with
    // arbitrary user errors or credential-bearing exception messages.
    return false;
  }
}

/**
 * Pure pre-start negotiation of the advertised *configuration* contract.
 * The optional requirement list is strict: EI never infers permission,
 * credentials, cross-process safety or effectively-once host side effects.
 */
export function negotiateHostContract(contract, {
  mcp, runtime, store, dataDir, env, semanticEvaluator, observability,
} = {}) {
  if (!contract || typeof contract !== 'object' ||
      Array.isArray(contract)) {
    throw contractError('EI_HOST_CONTRACT_INVALID',
      'hostContract must be an object with version and required capabilities');
  }
  if (contract.version !== HOST_CONTRACT_VERSION) {
    throw contractError('EI_HOST_CONTRACT_VERSION_UNSUPPORTED',
      'hostContract.version must be "1"; unsupported contract versions fail closed');
  }
  if (!Array.isArray(contract.required) ||
      contract.required.length > HOST_CONTRACT_CAPABILITIES.length ||
      contract.required.some(id => typeof id !== 'string')) {
    throw contractError('EI_HOST_CONTRACT_INVALID',
      'hostContract.required must be an array of supported capability IDs');
  }
  for (const key of Object.keys(contract)) {
    if (key !== 'version' && key !== 'required') {
      throw contractError('EI_HOST_CONTRACT_INVALID',
        'Unknown hostContract field: ' + key);
    }
  }
  if (new Set(contract.required).size !== contract.required.length) {
    throw contractError('EI_HOST_CONTRACT_INVALID',
      'hostContract.required must not contain duplicate capability IDs');
  }
  for (const id of contract.required) {
    if (!KNOWN.has(id)) {
      throw contractError('EI_HOST_CAPABILITY_UNKNOWN',
        'Unknown host capability: ' + id);
    }
  }

  // Store capability metadata is a host callback. Do NOT invoke it during
  // unrelated negotiations. This readiness report only verifies shared
  // storage when the host explicitly requires it.
  const sharedRequested = contract.required.includes('storage.shared');
  const available = Object.freeze({
    'mcp.registry': typeof mcp?.list === 'function' &&
      (mcp.subscribe === undefined || typeof mcp.subscribe === 'function'),
    'storage.durable': configuredDurability({ store, dataDir, env }),
    // A declared "shared" flag is never enough: check actual store
    // capability metadata AND its required distributed primitives.
    'storage.shared': sharedRequested && configuredSharedStore(store),
    'wake.receipts': typeof runtime?.hasReceipt === 'function' &&
      (typeof runtime?.receiptId === 'function' ||
        typeof runtime?.receiptNamespace === 'string' &&
        Boolean(runtime.receiptNamespace.trim())),
    'tooling.owner-scoped': typeof runtime?.resolveContext === 'function' &&
      typeof runtime?.control === 'function',
    // This is wiring readiness only; it does not execute an evaluator.
    'semantic.evaluate': Boolean(semanticEvaluator &&
      typeof semanticEvaluator === 'object' &&
      typeof semanticEvaluator.evaluate === 'function'),
    'observability.sink': typeof observability === 'function' ||
      Boolean(observability && typeof observability === 'object' &&
        typeof observability.emit === 'function'),
  });

  for (const id of contract.required) {
    if (!available[id]) {
      const code = id === 'storage.shared'
        ? 'EI_HOST_SHARED_STORE_REQUIRED'
        : id.startsWith('storage.')
          ? 'EI_HOST_STORAGE_REQUIRED' : 'EI_HOST_CAPABILITY_UNAVAILABLE';
      throw contractError(code,
        'Required host capability ' + id +
        ' is not configured; provide the corresponding host-owned boundary');
    }
  }
  return Object.freeze({
    schema: 'event-intelligence.host-contract.v1',
    version: HOST_CONTRACT_VERSION,
    required: Object.freeze([...contract.required]),
    available,
    // This is proof of shape only, not a runtime policy or receipt audit.
    readiness: 'configuration-validated',
  });
}
