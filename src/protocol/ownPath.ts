/**
 * Clone a JSON-shaped event value using OWN DATA DESCRIPTORS only.
 *
 * Ingress must snapshot BEFORE a schema parser, hashing, or matcher can
 * access arbitrary JS objects. No getters are invoked; sparse arrays cannot
 * obtain inherited elements. A bounded walk rejects cycles and oversized
 * synthetic input. Normal network JSON passes unchanged semantically.
 */
export function snapshotUntrustedEventData(source: unknown): unknown {
  const seen = new WeakSet<object>();
  let visited = 0;

  function invalid(reason: string): never {
    const error = new TypeError('Untrusted event data is not safe JSON: ' + reason);
    (error as TypeError & { code: string }).code = 'EVENT_UNTRUSTED_DATA_INVALID';
    throw error;
  }

  function copy(value: unknown, depth: number): unknown {
    if (++visited > 50000 || depth > 64) invalid('resource limit exceeded');
    if (value === null || typeof value === 'string' ||
        typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalid('non-finite numeric value');
      return value;
    }
    if (typeof value !== 'object') invalid('non-JSON value');
    if (seen.has(value)) invalid('circular reference');
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > 50000) invalid('array too large');
        const result: unknown[] = [];
        const descriptors = Object.getOwnPropertyDescriptors(value);
        for (let index = 0; index < value.length; index++) {
          const item = descriptors[String(index)];
          if (!item || !Object.hasOwn(item, 'value')) {
            invalid('array contains hole or accessor element');
          }
          result.push(copy(item.value, depth + 1));
        }
        return result;
      }
      const result: Record<string, unknown> = {};
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const [key, property] of Object.entries(descriptors)) {
        if (!property.enumerable) continue;
        if (!Object.hasOwn(property, 'value')) invalid('accessor property');
        // defineProperty cannot accidentally invoke inherited __proto__ or
        // custom setters on Object.prototype.
        Object.defineProperty(result, key, {
          value: copy(property.value, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      if (Object.getOwnPropertySymbols(value).some(
        symbol => Object.getOwnPropertyDescriptor(value, symbol)?.enumerable
      )) invalid('symbol property');
      return result;
    } finally {
      seen.delete(value);
    }
  }
  return copy(source, 0);
}

/** Own-only path traversal; return detached safe JSON for object/array values. */
export function readOwnEventPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const part of String(path).split('.')) {
    if (current === null || typeof current !== 'object' ||
        Array.isArray(current)) return undefined;
    const property = Object.getOwnPropertyDescriptor(current, part);
    if (!property || !Object.hasOwn(property, 'value')) return undefined;
    current = property.value;
  }
  if (current && typeof current === 'object') {
    // A selected array/object may contain inherited elements or nested
    // getters. Reject it as evidence rather than exporting the raw object
    // into predicates, aggregations or external semantic evaluators.
    try {
      return snapshotUntrustedEventData(current);
    } catch {
      return undefined;
    }
  }
  return current;
}
