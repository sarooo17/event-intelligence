/**
 * Minimal declaration for Node's intrinsic proxy test.
 *
 * EI currently builds without @types/node; this locally declares the only
 * Node runtime primitive needed to reject Proxy event evidence before any
 * userland trap. Runtime support is guaranteed by engines.node >=22.
 */
declare module 'node:util/types' {
  export function isProxy(value: unknown): boolean;
}
