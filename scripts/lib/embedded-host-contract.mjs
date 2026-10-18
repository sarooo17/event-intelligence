import {
  getHostDataMethod,
  getHostDataDescriptor,
  hasRequiredStoreMethods,
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
    try {
      return hasRequiredStoreMethods(store);
    } catch {
      // Host getters/Proxy traps are not configuration evidence. They may
      // contain private error messages; reject as a stable failed capability.
      return false;
    }
  }
  // The caller's own DATA_DIR data property overrides process.env. Never
  // run getters or Proxy traps merely to validate a storage path.
  try {
    let effectiveDir = dataDir;
    if (!effectiveDir) {
      const envValue = getHostDataDescriptor(env, 'DATA_DIR', true);
      if (envValue === null) return false;
      effectiveDir = envValue === undefined
        ? process.env.DATA_DIR : envValue.value;
    }
    return typeof effectiveDir === 'string' && Boolean(effectiveDir.trim());
  } catch {
    return false;
  }
}

function configuredMcpRegistry(mcp) {
  try {
    // MCP registry methods must be actual data descriptors, not accessors
    // or Proxy traps. subscribe is optional; an unsafe descriptor is not.
    const list = getHostDataMethod(mcp, 'list');
    if (typeof list !== 'function') return false;
    const subscribe = getHostDataMethod(mcp, 'subscribe');
    return subscribe === undefined || typeof subscribe === 'function';
  } catch {
    // Host metadata must never leak arbitrary exception text as a setup
    // error or execute untrusted getters during pre-start negotiation.
    return false;
  }
}

function configuredWakeReceipts(runtime) {
  try {
    const hasReceipt = getHostDataMethod(runtime, 'hasReceipt');
    if (typeof hasReceipt !== 'function') return false;
    const receiptId = getHostDataMethod(runtime, 'receiptId');
    if (typeof receiptId === 'function') return true;
    const namespace = getHostDataDescriptor(runtime, 'receiptNamespace');
    return Boolean(namespace && typeof namespace.value === 'string' &&
      namespace.value.trim());
  } catch {
    return false;
  }
}

function configuredOwnerScopedTooling(runtime) {
  try {
    return typeof getHostDataMethod(runtime, 'resolveContext') === 'function' &&
      typeof getHostDataMethod(runtime, 'control') === 'function';
  } catch {
    return false;
  }
}

function configuredSharedStore(store) {
  try {
    // Accessing storeCapabilities may itself run an accessor or Proxy trap:
    // both lookup and invocation must stay behind the same fail-closed guard.
    if (!configuredDurability({ store }) ||
        typeof getHostDataMethod(store, 'storeCapabilities') !== 'function')
      return false;
    return validateSharedStoreCapabilities(store).ok;
  } catch {
    // Never leak private metadata callback failures into a public setup
    // error, including failures during the property read itself.
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
  const registryRequested = contract.required.includes('mcp.registry');
  const durableRequested = sharedRequested ||
    contract.required.includes('storage.durable');
  const receiptsRequested = contract.required.includes('wake.receipts');
  const toolingRequested = contract.required.includes('tooling.owner-scoped');
  const available = Object.freeze({
    'mcp.registry': registryRequested && configuredMcpRegistry(mcp),
    'storage.durable': durableRequested && configuredDurability({ store, dataDir, env }),
    // A declared "shared" flag is never enough: check actual store
    // capability metadata AND its required distributed primitives.
    'storage.shared': sharedRequested && configuredSharedStore(store),
    'wake.receipts': receiptsRequested && configuredWakeReceipts(runtime),
    'tooling.owner-scoped': toolingRequested && configuredOwnerScopedTooling(runtime),
    // This is wiring readiness only; it does not execute an evaluator.
    'semantic.evaluate': contract.required.includes('semantic.evaluate') &&
      typeof getHostDataMethod(semanticEvaluator, 'evaluate') === 'function',
    'observability.sink': contract.required.includes('observability.sink') &&
      (typeof observability === 'function' ||
        typeof getHostDataMethod(observability, 'emit') === 'function'),
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
