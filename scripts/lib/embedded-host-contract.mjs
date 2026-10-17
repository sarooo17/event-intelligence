import { validateSharedStoreCapabilities } from './store-capabilities.mjs';

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
      typeof store.putTrigger === 'function' &&
      typeof store.getWakeDelivery === 'function' &&
      typeof store.completeWakeDelivery === 'function';
  }
  // The default JSONL store is durable when a location is configured; this
  // handshake cannot assert filesystem write permissions or crash recovery.
  return typeof dataDir === 'string' && Boolean(dataDir.trim()) ||
    typeof env?.DATA_DIR === 'string' && Boolean(env.DATA_DIR.trim());
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

  const available = Object.freeze({
    'mcp.registry': typeof mcp?.list === 'function' &&
      (mcp.subscribe === undefined || typeof mcp.subscribe === 'function'),
    'storage.durable': configuredDurability({ store, dataDir, env }),
    // A declared "shared" flag is never enough: check actual store
    // capability metadata AND its required distributed primitives.
    'storage.shared': Boolean(store) &&
      typeof store.storeCapabilities === 'function' &&
      validateSharedStoreCapabilities(store).ok,
    'wake.receipts': typeof runtime?.hasReceipt === 'function' &&
      (typeof runtime?.receiptId === 'function' ||
        typeof runtime?.receiptNamespace === 'string' &&
        Boolean(runtime.receiptNamespace.trim())),
    'tooling.owner-scoped': typeof runtime?.resolveContext === 'function' &&
      typeof runtime?.control === 'function',
    // This is wiring readiness only; it does not execute an evaluator.
    'semantic.evaluate': typeof semanticEvaluator === 'function' ||
      Boolean(semanticEvaluator && typeof semanticEvaluator === 'object' &&
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
