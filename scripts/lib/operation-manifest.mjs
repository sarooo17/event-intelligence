/**
 * Shared name and authority manifest for the in-process embedded catalog and
 * bundled stdio MCP surface. Input schemas remain surface-specific because
 * the two transports currently expose different authoring shapes (#43).
 */
export const OPERATION_MANIFEST_VERSION = '1';

function operation(name, {
  id, action = 'read', resource, durable = false,
  scope, embedded = false, stdio = true,
} = {}) {
  const mutation = action !== 'read';
  return Object.freeze({
    name,
    scope,
    surfaces: Object.freeze({ embedded, stdio }),
    capability: Object.freeze({
      id,
      operation: action,
      resource,
      effect: mutation ? 'durable-state' : 'none',
      durability: durable ? 'durable' : 'ephemeral',
      hostControl: mutation ? 'required' : 'none',
    }),
  });
}

export const OPERATION_MANIFEST = Object.freeze({
  sources: operation('event_sources_list', {
    id: 'event-intelligence.event-sources.list',
    resource: 'event-source', scope: 'host-source-registry', embedded: true,
  }),
  plan: operation('trigger_plan', {
    id: 'event-intelligence.trigger.plan',
    resource: 'trigger', scope: 'host-source-registry',
  }),
  languageDescribe: operation('trigger_language_describe', {
    id: 'event-intelligence.trigger-language.describe',
    resource: 'trigger-language', scope: 'public',
  }),
  create: operation('trigger_create', {
    id: 'event-intelligence.trigger.create', action: 'create',
    resource: 'trigger', scope: 'owner', durable: true, embedded: true,
  }),
  list: operation('trigger_list', {
    id: 'event-intelligence.trigger.list',
    resource: 'trigger', scope: 'owner', embedded: true,
  }),
  inspect: operation('trigger_inspect', {
    id: 'event-intelligence.trigger.inspect',
    resource: 'trigger', scope: 'owner', embedded: true,
  }),
  pause: operation('trigger_pause', {
    id: 'event-intelligence.trigger.pause', action: 'update',
    resource: 'trigger', scope: 'owner', durable: true, embedded: true,
  }),
  resume: operation('trigger_resume', {
    id: 'event-intelligence.trigger.resume', action: 'update',
    resource: 'trigger', scope: 'owner', durable: true, embedded: true,
  }),
  delete: operation('trigger_delete', {
    id: 'event-intelligence.trigger.delete', action: 'delete',
    resource: 'trigger', scope: 'owner', durable: true, embedded: true,
  }),
  update: operation('trigger_update', {
    id: 'event-intelligence.trigger.update', action: 'update',
    resource: 'trigger', scope: 'owner', durable: true, embedded: true,
  }),
  simulate: operation('trigger_simulate', {
    id: 'event-intelligence.trigger.simulate',
    resource: 'trigger', scope: 'host-supplied-input',
  }),
  derivedContracts: operation('derived_contracts_list', {
    id: 'event-intelligence.derived-contracts.list',
    resource: 'derived-contract', scope: 'runtime',
  }),
  wakeHydrate: operation('wake_hydrate', {
    id: 'event-intelligence.wake.hydrate',
    resource: 'wake', scope: 'owner',
  }),
  runtimeStatus: operation('runtime_status', {
    id: 'event-intelligence.runtime.status',
    resource: 'runtime', scope: 'operator',
  }),
});

/**
 * True only for the static tool surface; actual approval, principal routing,
 * source permissions and wake authorization remain host/server-owned.
 */
export function operationNamesForSurface(surface, {
  allowMutations = true,
} = {}) {
  if (surface !== 'embedded' && surface !== 'stdio') {
    throw new TypeError('Unknown EI tool surface');
  }
  return Object.values(OPERATION_MANIFEST)
    .filter((item) => item.surfaces[surface])
    .filter((item) =>
      allowMutations || item.capability.effect === 'none'
    )
    .map((item) => item.name);
}
