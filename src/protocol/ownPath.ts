/**
 * Read data fields from untrusted, JSON-shaped event evidence.
 *
 * Never traverse inherited properties or execute accessor getters. Payload
 * fields are data, not capabilities or host objects. Explicit own JSON keys
 * (including "__proto__") remain addressable as ordinary data.
 */
export function readOwnEventPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const part of String(path).split('.')) {
    if (current === null || typeof current !== 'object' ||
        Array.isArray(current)) return undefined;
    const property = Object.getOwnPropertyDescriptor(current, part);
    if (!property || !Object.hasOwn(property, 'value')) return undefined;
    current = property.value;
  }
  return current;
}
