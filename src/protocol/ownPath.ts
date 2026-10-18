import { Buffer } from 'node:buffer';
import { isProxy } from 'node:util/types';

/**
 * Clone a JSON-shaped event value using OWN DATA DESCRIPTORS only.
 *
 * Ingress must snapshot BEFORE a schema parser, hashing, or matcher can
 * access arbitrary JS objects. No getters are invoked; sparse arrays cannot
 * obtain inherited elements. A bounded walk rejects cycles and oversized
 * synthetic input. Normal network JSON passes unchanged semantically.
 */
const MAX_UNTRUSTED_EVENT_SNAPSHOT_BYTES = 4 * 1024 * 1024;

export function snapshotUntrustedEventData(source: unknown): unknown {
  const seen = new WeakSet<object>();
  let visited = 0;
  let accountedBytes = 0;

  function invalid(reason: string): never {
    const error = new TypeError('Untrusted event data is not safe JSON: ' + reason);
    (error as TypeError & { code: string }).code = 'EVENT_UNTRUSTED_DATA_INVALID';
    throw error;
  }

  // Count the UTF-8 size of primitive/key bytes BEFORE copying or hashing.
  // Brackets, quotes, punctuation are included as a conservative overhead.
  // This is a post-decode JavaScript snapshot cap, NOT an HTTP/MCP transport
  // response-size limit or a comprehensive per-tenant ingress rate limit.
  function account(bytes: number): void {
    accountedBytes += bytes;
    if (accountedBytes > MAX_UNTRUSTED_EVENT_SNAPSHOT_BYTES) {
      invalid('UTF-8 snapshot byte budget exceeded');
    }
  }

  function copy(value: unknown, depth: number): unknown {
    if (++visited > 50000 || depth > 64) invalid('resource limit exceeded');
    if (value === null) {
      account(4);
      return value;
    }
    if (typeof value === 'string') {
      account(Buffer.byteLength(value, 'utf8') + 2);
      return value;
    }
    if (typeof value === 'boolean') {
      account(value ? 4 : 5);
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalid('non-finite numeric value');
      account(String(value).length);
      return value;
    }
    if (typeof value !== 'object') invalid('non-JSON value');
    // Node's intrinsic proxy check cannot invoke userland traps. Reject
    // before Array.isArray(), descriptor reflection, length reads or hashing.
    if (isProxy(value)) invalid('proxy objects are not event data');
    if (seen.has(value)) invalid('circular reference');
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > 50000) invalid('array too large');
        account(value.length + 2); // separators and brackets
        const result: unknown[] = [];
        // Only indexed entries are semantically part of a JSON array.
        // Reflecting every own property first (getOwnPropertyDescriptors)
        // allocates an unbounded descriptor map for producer-added, unused
        // array metadata, even when length is within our 50k element cap.
        for (let index = 0; index < value.length; index++) {
          const item = Object.getOwnPropertyDescriptor(value, String(index));
          if (!item || !Object.hasOwn(item, 'value')) {
            invalid('array contains hole or accessor element');
          }
          result.push(copy(item.value, depth + 1));
        }
        return result;
      }
      account(2); // object braces
      const result: Record<string, unknown> = {};
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const [key, property] of Object.entries(descriptors)) {
        if (!property.enumerable) continue;
        if (!Object.hasOwn(property, 'value')) invalid('accessor property');
        account(Buffer.byteLength(key, 'utf8') + 4); // key quotes, colon, comma
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
    if (current === null || typeof current !== 'object') return undefined;
    // Never introspect a proxy, including a nested object at any level.
    if (isProxy(current) || Array.isArray(current)) return undefined;
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
