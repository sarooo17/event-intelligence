export const EVENT_INTELLIGENCE_STORE_CAPABILITIES_VERSION = '1';

export const LEGACY_STORE_CAPABILITIES = Object.freeze({
  version: EVENT_INTELLIGENCE_STORE_CAPABILITIES_VERSION,
  sharedState: 'none',
  scopeIsolation: 'unknown',
  wakeClaims: 'unknown',
  partitionLeases: 'none',
  mutableCompaction: 'none',
  readModel: 'synchronous',
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
  if (
    store &&
    typeof store.storeCapabilities === 'function'
  ) {
    return {
      ...LEGACY_STORE_CAPABILITIES,
      ...store.storeCapabilities(),
    };
  }
  return { ...LEGACY_STORE_CAPABILITIES };
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
  ]) {
    if (typeof store?.[method] !== 'function') {
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
