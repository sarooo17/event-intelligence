import { isProxy } from 'node:util/types';

/** Canonical minimum event-store surface required before the host can start.
 * Shared by the runtime initialization guard and the HostContract handshake
 * to prevent a partial custom store from initializing before rejection. */
export const REQUIRED_EVENT_STORE_METHODS = Object.freeze([
  'putTrigger',
  'listTriggers',
  'getTriggerState',
  'setTriggerState',
  'appendTriggerMatch',
  'listTriggerMatches',
  'putEventSource',
  'listEventSources',
  'appendWake',
  'latestWake',
  'ensureWakeDelivery',
  'getWakeDelivery',
  'claimWakeDelivery',
  'completeWakeDelivery',
  'failWakeDelivery',
  'listDueWakeDeliveries',
  'appendAudit',
  'auditLength',
  'getMcpClientState',
  'listMcpClientStates',
  'putMcpClientState',
  'appendMcpOccurrence',
  // The temporal scheduler starts with the host; these are not optional
  // merely because a custom store offers durable wake methods.
  'putTemporalDeadline',
  'getTemporalDeadline',
  'listTemporalDeadlines',
  'listDueTemporalDeadlines',
  'setTemporalDeadlineStatus',
]);


/**
 * Read a host-provided method without invoking accessors or Proxy traps.
 * Resolve ordinary inherited class methods, but never dynamic getters.
 *
 * undefined: no method; null: unsafe/noncallable descriptor or Proxy;
 * function: callable own/prototype DATA method.
 */
export function getHostDataMethod(receiver, key) {
  if (!receiver || typeof receiver !== 'object') return undefined;
  let current = receiver;
  for (let depth = 0; depth < 24 && current !== null; depth++) {
    if (isProxy(current)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      return Object.hasOwn(descriptor, 'value') &&
        typeof descriptor.value === 'function'
        ? descriptor.value : null;
    }
    current = Object.getPrototypeOf(current);
  }
  return null;
}

export function hasRequiredStoreMethods(store) {
  return Boolean(store && typeof store === 'object' &&
    REQUIRED_EVENT_STORE_METHODS.every(method =>
      typeof getHostDataMethod(store, method) === 'function'));
}

export const EVENT_INTELLIGENCE_STORE_CAPABILITIES_VERSION = '1';

export const UNDECLARED_STORE_CAPABILITIES = Object.freeze({
  version: EVENT_INTELLIGENCE_STORE_CAPABILITIES_VERSION,
  sharedState: 'none',
  scopeIsolation: 'unknown',
  wakeClaims: 'unknown',
  partitionLeases: 'none',
  mutableCompaction: 'none',
  readModel: 'undeclared',
});

export const REFERENCE_STORE_CAPABILITIES = Object.freeze({
  version: EVENT_INTELLIGENCE_STORE_CAPABILITIES_VERSION,
  sharedState: 'single-process',
  scopeIsolation: 'strong',
  wakeClaims: 'process-atomic',
  partitionLeases: 'process-atomic',
  mutableCompaction: 'atomic-snapshot',
  readModel: 'synchronous-materialized',
});

export function describeStoreCapabilities(store) {
  const metadata = getHostDataMethod(store, 'storeCapabilities');
  if (typeof metadata === 'function') {
    return {
      ...UNDECLARED_STORE_CAPABILITIES,
      ...metadata.call(store),
    };
  }
  return { ...UNDECLARED_STORE_CAPABILITIES };
}

export function validateSharedStoreCapabilities(store) {
  const capabilities = describeStoreCapabilities(store);
  const errors = [];

  if (capabilities.sharedState !== 'strong') {
    errors.push(
      `sharedState must be strong; received ${capabilities.sharedState}`,
    );
  }
  if (capabilities.scopeIsolation !== 'strong') {
    errors.push(
      `scopeIsolation must be strong; received ${capabilities.scopeIsolation}`,
    );
  }
  if (capabilities.wakeClaims !== 'distributed-atomic') {
    errors.push(
      `wakeClaims must be distributed-atomic; received ${capabilities.wakeClaims}`,
    );
  }
  if (capabilities.partitionLeases !== 'distributed-atomic') {
    errors.push(
      `partitionLeases must be distributed-atomic; received ${capabilities.partitionLeases}`,
    );
  }
  for (const method of [
    'claimPartitionLease',
    'renewPartitionLease',
    'releasePartitionLease',
    'compareAndAppendTriggerMatch',
  ]) {
    if (typeof getHostDataMethod(store, method) !== 'function') {
      errors.push(`shared store is missing ${method}()`);
    }
  }

  return {
    ok: errors.length === 0,
    capabilities,
    errors,
  };
}

export function assertSharedStoreCapabilities(store) {
  const result = validateSharedStoreCapabilities(store);
  if (result.ok) return result.capabilities;

  const error = new Error(
    'Event Intelligence shared-store requirements failed: ' +
      result.errors.join('; '),
  );
  error.code = 'EVENT_INTELLIGENCE_SHARED_STORE_REQUIRED';
  error.details = result;
  throw error;
}
