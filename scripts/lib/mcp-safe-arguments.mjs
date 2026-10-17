import { isProxy } from 'node:util/types';

// Source/subscription identity must be immutable, ordinary JSON. In particular,
// structuredClone() preserves SharedArrayBuffer backing memory on typed views,
// allowing callers to modify the materialized completeness index without a
// durable state mutation. Reject all exotic objects, accessors and proxies
// before cloning or canonicalizing any host-supplied identity arguments.
const MAX_DEPTH = 48;
const MAX_NODES = 16384;
const MAX_FIELDS = 16384;
const MAX_STRING_LENGTH = 1_048_576;

export function safeMcpSourceArguments(input) {
  if (input == null) return {};
  const seen = new WeakSet();
  let nodes = 0;
  let fields = 0;
  const copy = (value, depth) => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) {
      throw new Error('MCP source arguments exceed safe JSON limits');
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (value.length > MAX_STRING_LENGTH) {
        throw new Error('MCP source arguments exceed safe JSON limits');
      }
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || isProxy(value)) {
      throw new Error('MCP source arguments must be safe JSON');
    }
    if (seen.has(value)) {
      throw new Error('MCP source arguments must not contain shared objects or cycles');
    }
    // Reject typed views, SharedArrayBuffer, ArrayBuffer, Date, Map, Set, etc.
    // Plain JSON objects and arrays are the only allowed reference types.
    const isArray = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (isArray ? prototype !== Array.prototype :
        prototype !== Object.prototype && prototype !== null) {
      throw new Error('MCP source arguments must be safe JSON');
    }
    seen.add(value);
    if (isArray) {
      const size = value.length;
      if (size > MAX_FIELDS || fields + size > MAX_FIELDS) {
        throw new Error('MCP source arguments exceed safe JSON limits');
      }
      fields += size;
      const result = [];
      for (let i = 0; i < size; i += 1) {
        const slot = Object.getOwnPropertyDescriptor(value, String(i));
        if (!slot || !Object.hasOwn(slot, 'value') || !slot.enumerable) {
          throw new Error('MCP source arguments must be dense safe JSON arrays');
        }
        result.push(copy(slot.value, depth + 1));
      }
      // Extra named array keys are not valid JSON identity data.
      if (Reflect.ownKeys(value).length !== size + 1) {
        throw new Error('MCP source arguments must be safe JSON');
      }
      seen.delete(value);
      return result;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string') ||
        fields + keys.length > MAX_FIELDS) {
      throw new Error('MCP source arguments must be safe JSON');
    }
    fields += keys.length;
    const result = {};
    for (const key of keys) {
      if (key.length > MAX_STRING_LENGTH) {
        throw new Error('MCP source arguments exceed safe JSON limits');
      }
      const slot = Object.getOwnPropertyDescriptor(value, key);
      if (!slot || !slot.enumerable || !Object.hasOwn(slot, 'value')) {
        throw new Error('MCP source arguments must be safe JSON');
      }
      Object.defineProperty(result, key, {
        value: copy(slot.value, depth + 1),
        enumerable: true, writable: true, configurable: true,
      });
    }
    seen.delete(value);
    return result;
  };
  const output = copy(input, 0);
  if (!output || Array.isArray(output) || typeof output !== 'object') {
    throw new Error('MCP source arguments must be a JSON object');
  }
  return output;
}
