import { isProxy } from 'node:util/types';

// Inspect only *own, data* descriptors. Calling .code, .data or .kind on
// an untrusted exception could execute a getter/Proxy and leak credentials.
function ownData(record, field) {
  if (!record || typeof record !== 'object' || isProxy(record)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, field);
  return descriptor && Object.hasOwn(descriptor, 'value')
    ? descriptor.value : undefined;
}

/**
 * Recognize only the current experimental SEP-3415 terminal failure subset.
 * This function never returns provider-controlled text or objects.
 */
export function classifyTerminalMcpProviderError(error) {
  const code = ownData(error, 'code');
  if (code !== -32023 && code !== -32024) return null;
  const kind = ownData(ownData(error, 'data'), 'kind');
  if (!['event', 'subscription', 'connection'].includes(kind)) return null;
  if (code === -32023 && kind === 'connection') return null;
  return code === -32024
    ? { reason: 'forbidden', scope: 'connection' }
    : { reason: 'not_found', scope: 'subscription' };
}
