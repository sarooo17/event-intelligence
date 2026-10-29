import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { snapshotUntrustedEventData } from '../../dist/src/protocol/ownPath.js';
import * as z from 'zod/v4';
import { classifyTerminalMcpProviderError } from './mcp-provider-terminal-error.mjs';
import {
  McpEventOccurrenceSchema,
} from '../../dist/src/intelligenceProtocol/index.js';
import {
  DEFAULT_EVENT_SCOPE_ID,
  normalizeEventScopeId,
} from './persistent-event-store.mjs';
import { assertJsonSchemaValue } from './json-schema.mjs';
import {
  MCP_EVENTS_EXTENSION_ID,
  getMcpEventsCompatibilityProfile,
  resolveMcpEventsCompatibilityProfile,
} from './mcp-events-compatibility.mjs';

export { assertJsonSchemaValue } from './json-schema.mjs';
export { MCP_EVENTS_EXTENSION_ID } from './mcp-events-compatibility.mjs';
const UnknownResultSchema = z.unknown();

// A producer is not an authority for operator/model-facing diagnostics.
// Exception messages, non-Error throws, and stream termination details may
// contain bearer credentials or arbitrary private event data that no regex
// can identify. Never stringify or propagate them across this boundary.
const PROVIDER_ERROR_MESSAGE = 'MCP Events provider operation failed';
const CAPABILITY_ERROR_MESSAGE = 'MCP Events capability unavailable';

export function isUnavailableCapability(error) {
  if (!error || typeof error !== 'object' || isProxy(error)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return descriptor && Object.hasOwn(descriptor, 'value') &&
    descriptor.value === 'MCP_EVENTS_CAPABILITY_UNAVAILABLE';
}

function safeMcpFailure(error) {
  return isUnavailableCapability(error)
    ? CAPABILITY_ERROR_MESSAGE : PROVIDER_ERROR_MESSAGE;
}


// Bound untrusted paginated MCP Events source catalogues before parsing or
// persisting descriptors. These limits apply per host-managed MCP connection.
export const MAX_MCP_EVENT_DISCOVERY_PAGES = 32;
export const MAX_MCP_EVENT_DISCOVERY_SOURCES = 256;
export const MAX_MCP_EVENT_CURSOR_BYTES = 4096;
export const DEFAULT_MCP_OCCURRENCE_BYTES = 262144;
export const DEFAULT_MCP_POLL_PAGE_BYTES = 1048576;
export const DEFAULT_MCP_DISCOVERY_BYTES = 1048576;

// These are post-decoding JSON limits. The host remains responsible for
// transport/body byte and wall-time admission BEFORE parsing untrusted RPC.
function assertDecodedMcpBytes(value, limit, kind) {
  const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (size > limit) {
    const error = new Error('MCP Events decoded input exceeds configured byte budget');
    error.code = 'MCP_EVENTS_DECODED_BYTE_LIMIT_EXCEEDED';
    error.kind = kind; // Fixed dimension only; never include producer data.
    throw error;
  }
  return size;
}


// MCP SDK capabilities are host-owned but may be backed by untrusted adapter
// objects. Only the one advertised extension *identity* is used here.
// Project it by own data descriptor; never evaluate provider getters/Proxies.
function safeMcpCapabilities(raw) {
  const invalid = () => {
    const error = new Error('MCP Events capabilities are unsafe');
    error.code = 'MCP_EVENTS_CAPABILITY_INVALID';
    throw error;
  };
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw) || isProxy(raw)) invalid();
  const extensionsSlot = Object.getOwnPropertyDescriptor(raw, 'extensions');
  if (!extensionsSlot) return {};
  if (!Object.hasOwn(extensionsSlot, 'value')) invalid();
  const extensions = extensionsSlot.value;
  if (extensions == null) return {};
  if (typeof extensions !== 'object' ||
      Array.isArray(extensions) || isProxy(extensions)) return {};
  const extension = Object.getOwnPropertyDescriptor(
    extensions, MCP_EVENTS_EXTENSION_ID,
  );
  if (!extension) return {};
  if (!Object.hasOwn(extension, 'value')) invalid();
  return { extensions: { [MCP_EVENTS_EXTENSION_ID]: true } };
}

// A valid-looking fulfilled poll response can hide private data inside
// accessors, even though the request promise itself never rejected.
// Snapshot ONLY fields used by polling; retain the existing per-page event
// count limit before deep-copying the bounded event array.
function ownPollPage(raw) {
  const invalid = () => {
    const error = new Error('MCP Events poll page is unsafe');
    error.code = 'MCP_EVENTS_POLL_PAGE_INVALID';
    throw error;
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      isProxy(raw)) invalid();
  const page = {};
  for (const field of ['events', 'cursor', 'hasMore', 'truncated', 'nextPollMs']) {
    const slot = Object.getOwnPropertyDescriptor(raw, field);
    if (!slot) {
      if (field === 'events') invalid();
      continue;
    }
    if (!Object.hasOwn(slot, 'value')) invalid();
    Object.defineProperty(page, field, {
      value: slot.value, enumerable: true,
      configurable: true, writable: true,
    });
  }
  return page;
}

// A fulfilled push/webhook subscription can be an untrusted JavaScript
// handle, including accessor-backed cursor or lifecycle methods. Read slots
// from data descriptors only; never invoke a getter or Proxy trap.
function deliveryHandleSlot(raw, field, inherited = false) {
  let owner = raw;
  for (let depth = 0; owner != null && depth < 5; depth++) {
    if (isProxy(owner)) {
      const error = new Error('MCP Events delivery handle is unsafe');
      error.code = 'MCP_EVENTS_DELIVERY_HANDLE_INVALID';
      throw error;
    }
    const slot = Object.getOwnPropertyDescriptor(owner, field);
    if (slot) {
      if (!Object.hasOwn(slot, 'value')) {
        const error = new Error('MCP Events delivery handle is unsafe');
        error.code = 'MCP_EVENTS_DELIVERY_HANDLE_INVALID';
        throw error;
      }
      return { present: true, value: slot.value };
    }
    if (!inherited) break;
    owner = Object.getPrototypeOf(owner);
  }
  return { present: false };
}

async function projectDeliveryHandle(handle) {
  const invalid = () => {
    const error = new Error('MCP Events delivery handle is unsafe');
    error.code = 'MCP_EVENTS_DELIVERY_HANDLE_INVALID';
    throw error;
  };
  if (handle == null) {
    return { close: async () => {}, hasCursor: false, cursor: null, truncated: false };
  }
  if ((typeof handle !== 'function' && typeof handle !== 'object') ||
      Array.isArray(handle) || isProxy(handle)) invalid();

  const teardownCandidates = typeof handle === 'function'
    ? [handle]
    : [];
  let invalidLifecycleSlot = false;
  if (typeof handle !== 'function') {
    for (const method of ['close', 'cancel', 'unsubscribe']) {
      let slot;
      try {
        slot = deliveryHandleSlot(handle, method, true);
      } catch {
        // Do not invoke hostile accessors, but keep scanning for safe
        // independent teardown methods on an already opened stream.
        invalidLifecycleSlot = true;
        continue;
      }
      if (typeof slot.value === 'function') {
        teardownCandidates.push(() => slot.value.call(handle));
      }
    }
  }
  const close = async () => {
    for (const teardown of teardownCandidates) {
      try {
        await teardown();
        return;
      } catch {
        // A safe descriptor may still be a failed transport operation.
        // Try the next method so an active stream is not orphaned.
      }
    }
  };

  if (invalidLifecycleSlot) {
    try { await close(); } catch {}
    invalid();
  }

  try {
    const cursor = deliveryHandleSlot(handle, 'cursor');
    const truncated = deliveryHandleSlot(handle, 'truncated');
    return {
      close,
      hasCursor: cursor.present,
      cursor: cursor.value,
      truncated: truncated.value === true,
    };
  } catch (error) {
    // On an invalid metadata field, retire an already-opened stream using
    // the safe method descriptor found above before propagating failure.
    try { await close(); } catch {}
    throw error;
  }
}

function discoveryLimitError(detail) {
  const error = new Error('MCP Events discovery rejected: ' + detail);
  error.code = 'MCP_EVENTS_DISCOVERY_LIMIT_EXCEEDED';
  return error;
}

// The transport is owned by the host, but decoded events/list objects are
// producer-controlled input. Never access their fields through ordinary JS
// property reads: a host adapter could supply Proxies or getter-backed values.
function ownDiscoveryPage(raw, connectionId) {
  const invalid = () => {
    const error = new Error(
      `MCP server ${connectionId} returned unsafe events/list page`,
    );
    error.code = 'MCP_EVENTS_DISCOVERY_PAGE_INVALID';
    throw error;
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || isProxy(raw)) {
    invalid();
  }
  const events = Object.getOwnPropertyDescriptor(raw, 'events');
  const cursor = Object.getOwnPropertyDescriptor(raw, 'nextCursor');
  if (!events || !Object.hasOwn(events, 'value') ||
      (cursor && !Object.hasOwn(cursor, 'value'))) {
    invalid();
  }
  if (isProxy(events.value) || !Array.isArray(events.value)) {
    invalid();
  }
  return { events: events.value, nextCursor: cursor?.value };
}

// Only these six top-level descriptor fields are consumed by
// sourceDescriptor(). Other own properties are ignored, not reflected as
// untrusted JSON; a producer can otherwise attach millions of irrelevant
// enumerable keys to a one-event discovery response.
const DISCOVERY_DESCRIPTOR_FIELDS = Object.freeze([
  'name', 'description', 'delivery', 'inputSchema', 'payloadSchema', '_meta',
]);

function stageDiscoveryDescriptor(raw) {
  const invalid = () => {
    const error = new Error('MCP Events discovery rejected: unsafe descriptor');
    error.code = 'EVENT_UNTRUSTED_DATA_INVALID';
    throw error;
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || isProxy(raw)) {
    invalid();
  }
  const staged = {};
  for (const field of DISCOVERY_DESCRIPTOR_FIELDS) {
    const slot = Object.getOwnPropertyDescriptor(raw, field);
    if (!slot) continue;
    if (!Object.hasOwn(slot, 'value')) invalid();
    Object.defineProperty(staged, field, {
      value: slot.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return staged;
}

function assertObject(value, message) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(message);
  }
  return value;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value ?? {}));
}

export function eventSubscriptionId(connectionId, eventName, args = {}) {
  const digest = createHash('sha256')
    .update(
      `${String(connectionId)}\u0000${String(eventName)}\u0000${stableJson(args)}`,
    )
    .digest('hex')
    .slice(0, 24);
  return `mcp_sub_${digest}`;
}

function normalizePositiveInteger(value, fallback, min, max, name) {
  const normalized = Number(value ?? fallback);
  if (!Number.isInteger(normalized) || normalized < min || normalized > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return normalized;
}

function normalizePollFloorMs(value) {
  const floor=value===undefined?1000:value;
  if(typeof floor!=='number' || !Number.isInteger(floor) ||
    floor<1000 || floor>300000) {
    throw new Error('pollFloorMs must be an integer between 1000 and 300000');
  }
  return floor;
}

function normalizeConnection(connection) {
  assertObject(connection, 'Invalid host-managed MCP Events connection');
  const connectionId = String(connection.connectionId || '').trim();
  if (!connectionId) {
    throw new Error('Host-managed MCP Events connectionId is required');
  }
  if (typeof connection.request !== 'function') {
    throw new Error(
      `Host-managed MCP Events connection ${connectionId} requires request(method, params)`,
    );
  }
  if (typeof connection.getCapabilities !== 'function') {
    throw new Error(
      `Host-managed MCP Events connection ${connectionId} requires getCapabilities()`,
    );
  }

  const preferredDelivery = connection.preferredDelivery
    ? String(connection.preferredDelivery)
    : null;
  if (
    preferredDelivery &&
    !['poll', 'push', 'webhook'].includes(preferredDelivery)
  ) {
    throw new Error(
      `Host-managed MCP Events connection ${connectionId} has invalid preferredDelivery`,
    );
  }

  return {
    connectionId,
    scopeId: normalizeEventScopeId(
      connection.scopeId ?? DEFAULT_EVENT_SCOPE_ID,
    ),
    serverId: String(connection.serverId || `host-mcp:${connectionId}`),
    request: connection.request,
    getCapabilities: connection.getCapabilities,
    identity: connection.identity ?? connection.request,
    enabled: connection.enabled !== false,
    pollIntervalMs: normalizePositiveInteger(
      connection.pollIntervalMs,
      5000,
      250,
      300000,
      'pollIntervalMs',
    ),
    pollFloorMs: normalizePollFloorMs(connection.pollFloorMs),
    maxEvents: normalizePositiveInteger(
      connection.maxEvents,
      100,
      1,
      500,
      'maxEvents',
    ),
    maxPollBatches: normalizePositiveInteger(
      connection.maxPollBatches,
      4,
      1,
      32,
      'maxPollBatches',
    ),
    maxOccurrenceBytes: normalizePositiveInteger(
      connection.maxOccurrenceBytes, DEFAULT_MCP_OCCURRENCE_BYTES,
      1024, 1048576, 'maxOccurrenceBytes',
    ),
    maxPollPageBytes: normalizePositiveInteger(
      connection.maxPollPageBytes, DEFAULT_MCP_POLL_PAGE_BYTES,
      1024, 4194304, 'maxPollPageBytes',
    ),
    // Host-generated epoch, never derived from provider payload. PostgreSQL
    // must be configured requireMcpSessionFence=true in shared-worker mode.
    authorityEpoch: connection.authorityEpoch == null ? null
      : (typeof connection.authorityEpoch === 'string' &&
         connection.authorityEpoch.length >= 32 &&
         connection.authorityEpoch.length <= 256
          ? connection.authorityEpoch
          : (()=>{throw new TypeError('Invalid host MCP session authority epoch')})()),
    maxDiscoveryBytes: normalizePositiveInteger(
      connection.maxDiscoveryBytes, DEFAULT_MCP_DISCOVERY_BYTES,
      1024, 4194304, 'maxDiscoveryBytes',
    ),
    preferredDelivery,
    compatibilityProfile:
      connection.compatibilityProfile === undefined
        ? 'auto'
        : String(connection.compatibilityProfile),
    openEventStream:
      typeof connection.openEventStream === 'function'
        ? connection.openEventStream
        : null,
    createWebhookSubscription:
      typeof connection.createWebhookSubscription === 'function'
        ? connection.createWebhookSubscription
        : null,
  };
}

/**
 * Adapt an MCP client already connected and authorized by the host.
 *
 * Poll works with the ordinary MCP request surface. Push and webhook remain
 * host-owned transport concerns: a host can provide openEventStream() and/or
 * createWebhookSubscription() adapters without giving Event Intelligence
 * transport credentials or callback infrastructure.
 */
export function createHostMcpEventsConnection({
  connectionId,
  serverId,
  client,
  request,
  getCapabilities,
  capabilities,
  enabled = true,
  pollIntervalMs = 5000,
  pollFloorMs = 1000,
  maxEvents = 100,
  maxPollBatches = 4,
  maxOccurrenceBytes = DEFAULT_MCP_OCCURRENCE_BYTES,
  maxPollPageBytes = DEFAULT_MCP_POLL_PAGE_BYTES,
  maxDiscoveryBytes = DEFAULT_MCP_DISCOVERY_BYTES,
  authorityEpoch = null,
  scopeId = DEFAULT_EVENT_SCOPE_ID,
  preferredDelivery,
  compatibilityProfile = 'auto',
  openEventStream,
  createWebhookSubscription,
} = {}) {
  const directRequest =
    typeof request === 'function'
      ? request
      : client && typeof client.request === 'function'
        ? async (method, params) => {
            const message = {
              method,
              ...(params === undefined ? {} : { params }),
            };
            return client.request(message, UnknownResultSchema);
          }
        : null;

  const directCapabilities =
    typeof getCapabilities === 'function'
      ? getCapabilities
      : client && typeof client.getServerCapabilities === 'function'
        ? async () => client.getServerCapabilities()
        : capabilities && typeof capabilities === 'object'
          ? async () => capabilities
          : null;

  return normalizeConnection({
    connectionId,
    serverId,
    request: directRequest,
    getCapabilities: directCapabilities,
    identity: client ?? request ?? directRequest,
    enabled,
    pollIntervalMs,
    pollFloorMs,
    maxEvents,
    maxPollBatches,
    maxOccurrenceBytes,
    maxPollPageBytes,
    maxDiscoveryBytes,
    authorityEpoch,
    scopeId,
    preferredDelivery,
    compatibilityProfile,
    openEventStream,
    createWebhookSubscription,
  });
}

function sourceDescriptor(raw, profile) {
  const descriptor = assertObject(raw, 'Invalid MCP event descriptor');
  const name = String(descriptor.name || '').trim();
  if (!name) throw new Error('MCP event descriptor requires name');
  const delivery = Array.isArray(descriptor.delivery)
    ? descriptor.delivery.map(String)
    : [];
  if (
    delivery.length === 0 ||
    delivery.some((mode) => !profile.deliveryModes.includes(mode))
  ) {
    throw new Error(`MCP event descriptor ${name} has invalid delivery modes`);
  }
  return {
    name,
    description: String(descriptor.description || ''),
    delivery,
    inputSchema:
      descriptor.inputSchema &&
      !Array.isArray(descriptor.inputSchema) &&
      typeof descriptor.inputSchema === 'object'
        ? descriptor.inputSchema
        : {},
    payloadSchema:
      descriptor.payloadSchema &&
      !Array.isArray(descriptor.payloadSchema) &&
      typeof descriptor.payloadSchema === 'object'
        ? descriptor.payloadSchema
        : {},
    ...(descriptor._meta &&
    !Array.isArray(descriptor._meta) &&
    typeof descriptor._meta === 'object'
      ? { _meta: descriptor._meta }
      : {}),
  };
}

function normalizeCursor(cursor, label) {
  if (cursor === null || cursor === undefined) return null;
  if (typeof cursor === 'string') return cursor;
  throw new Error(`${label} returned invalid cursor; expected string|null`);
}

function normalizeNextPollMs(value, fallback) {
  // Untrusted nextPollMs must be a number: Number(object) executes
  // provider-controlled valueOf/toString, potentially throwing secrets.
  const result = value ?? fallback;
  if (typeof result !== 'number' ||
      !Number.isInteger(result) || result < 0 || result > 300000) {
    throw new Error('events/poll returned invalid nextPollMs');
  }
  return result;
}

function supportsMode(connection, mode) {
  if (mode === 'poll') return true;
  if (mode === 'push') return typeof connection.openEventStream === 'function';
  if (mode === 'webhook') {
    return typeof connection.createWebhookSubscription === 'function';
  }
  return false;
}

function chooseDelivery(connection, descriptor) {
  const advertised = descriptor.delivery;
  if (
    connection.preferredDelivery &&
    advertised.includes(connection.preferredDelivery) &&
    supportsMode(connection, connection.preferredDelivery)
  ) {
    return connection.preferredDelivery;
  }

  for (const mode of ['push', 'webhook', 'poll']) {
    if (advertised.includes(mode) && supportsMode(connection, mode)) {
      return mode;
    }
  }
  return null;
}

export class McpEventsClientManager {
  constructor({
    store,
    compositeEventConsumer,
    registerEventSource,
    resolveScope = null,
    connections = [],
    now = () => new Date(),
    observability = null,
  }) {
    this.store = store;
    this.compositeEventConsumer = compositeEventConsumer;
    this.registerEventSource = registerEventSource;
    this.resolveScope = resolveScope;
    this.connections = new Map();
    this.now = now;
    this.observability = observability;
    this.descriptors = new Map();
    this.profiles = new Map();
    this.timers = new Map();
    this.lastErrors = new Map();
    // Connection identity, not reusable connectionId, fences terminal poll
    // responses against a later host-managed session replacement.
    this.terminalPollSubscriptions = new WeakMap();
    this.terminalConnections = new WeakSet();
    this.scopeContexts = new Map();
    this.pollInFlight = new Map();
    // Serialize durable source/cursor mutations by connection ID, including
    // detach's disable operation. A new session cannot overwrite or race
    // old-session cleanup even when it reuses the same connection ID.
    this.connectionMutations = new Map();
    this.deliverySessions = new Map();
    this.started = false;
    this.closed = false;
    this.closePromise = null;
    // All direct, scoped and registry attach operations share this manager.
    // A host close must drain them before the owning store is torn down.
    this.attachInFlight = new Set();
    // Detach disables durable sources and closes host-owned sessions.
    // A detach accepted before close must finish before store teardown.
    this.detachInFlight = new Set();
    // Host-only reconciliation can read/write durable gap evidence during
    // close; every accepted operation must settle before store shutdown.
    this.reconciliationInFlight = new Set();
    // Detach session teardown needs a cancellable close notification.
    // A never-settled Promise.then would retain every completed detach on
    // long-lived hosts until the eventual process shutdown.
    this.shutdownListeners = new Set();
    // Push/webhook providers may retain callback references after session
    // cleanup. Track callbacks accepted before shutdown; reject later ones.
    this.deliveryCallbackInFlight = new Set();
    this.occurrenceInFlight = new Set();
    // Retain failed revocations even when detach removed connection objects.
    // A host may retry close after an unavailable PostgreSQL scope recovers.
    this.pendingAuthorityRevocations = new Map();

    for (const connection of connections) {
      this.addConnection(connection);
    }
  }

  async scopeContext(connection) {
    const cacheKey = `${connection.connectionId}::${connection.scopeId}`;
    const cached = this.scopeContexts.get(cacheKey);
    if (cached) return cached;

    const context =
      typeof this.resolveScope === 'function'
        ? await this.resolveScope(connection.scopeId)
        : {
            store: this.store,
            compositeEventConsumer: this.compositeEventConsumer,
            triggerControl: null,
          };

    if (!context || !context.store || !context.compositeEventConsumer) {
      throw new Error(
        `Invalid Event Intelligence scope context for ${connection.scopeId}`,
      );
    }

    this.scopeContexts.set(cacheKey, context);
    return context;
  }

  assertOpen() {
    if (this.closed) {
      const error = new Error('Event Intelligence MCP client manager is closed');
      error.code = 'EI_HOST_CLOSED';
      throw error;
    }
  }

  addConnection(input) {
    this.assertOpen();
    const connection = normalizeConnection(input);
    if (connection.enabled === false) return connection;
    if (this.connections.has(connection.connectionId)) {
      throw new Error(
        `Host-managed MCP Events connection already attached: ${connection.connectionId}`,
      );
    }
    this.connections.set(connection.connectionId, connection);
    return connection;
  }

  /** Compare the actual host-owned connection object, not just its ID.
   * A revoked session and a replacement can legitimately reuse connectionId.
   */
  isConnectionAttached(connection) {
    return connection?.enabled !== false &&
      this.connections.get(connection?.connectionId) === connection;
  }

  assertConnectionAttached(connection) {
    // Already-accepted poll work is allowed to finish while close() drains
    // it. New work is denied by add/attach/discover/poll entry guards.
    if (!this.isConnectionAttached(connection)) {
      const error = new Error('Host MCP Events connection is detached');
      error.code = 'MCP_EVENTS_CONNECTION_DETACHED';
      throw error;
    }
  }

  withConnectionMutation(connectionId, operation) {
    const previous = this.connectionMutations.get(connectionId)
      ?? Promise.resolve();
    // Never leave the queue poisoned by a failed previous mutation.
    const result = previous.then(operation);
    const settled = result.then(() => {}, () => {});
    this.connectionMutations.set(connectionId, settled);
    void settled.then(() => {
      if (this.connectionMutations.get(connectionId) === settled) {
        this.connectionMutations.delete(connectionId);
      }
    });
    return result;
  }

  async prepareConnectionAuthority(connection) {
    if (!connection.authorityEpoch) return;
    await this.withConnectionMutation(connection.connectionId, async()=>{
      this.assertConnectionAttached(connection);
      const context=await this.scopeContext(connection);
      if (context.store.requireMcpSessionFence!==true ||
          typeof context.store.beginMcpConnectionAuthority!=='function') {
        throw new Error('Host MCP connection requires an enabled PostgreSQL authority fence');
      }
      await context.store.beginMcpConnectionAuthority({
        connectionId:connection.connectionId,epoch:connection.authorityEpoch,
      });
      this.assertConnectionAttached(connection);
    });
  }

  async prepareConnectionAuthorities() {
    for(const connection of this.connections.values()) {
      await this.prepareConnectionAuthority(connection);
    }
  }

  async attachConnection(input, { discover = true } = {}) {
    const connection = this.addConnection(input);
    const pending = (async () => {
      let events = [];
      if (connection.enabled !== false)await this.prepareConnectionAuthority(connection);
      if (connection.enabled !== false && discover) {
        events = await this.discoverConnection(connection.connectionId);
      }
      this.assertOpen();
      if (connection.enabled !== false) this.assertConnectionAttached(connection);
      if (connection.enabled !== false && this.started) {
        this.scheduleConnection(connection, 0);
      }
      return { connectionId: connection.connectionId, events };
    })();
    this.attachInFlight.add(pending);
    try {
      return await pending;
    } finally {
      this.attachInFlight.delete(pending);
    }
  }

  trackDeliveryCallback(operation) {
    if (this.closed) return Promise.resolve();
    // Invoke the accepted ingress synchronously: the onEvent/onActive/onGap
    // handlers take their own-data snapshots before their first await. A
    // deferred .then(operation) would let a producer mutate event/cursor
    // objects after invoking the callback but before we copied them.
    let task;
    try {
      task = Promise.resolve(operation());
    } catch (error) {
      task = Promise.reject(error);
    }
    this.deliveryCallbackInFlight.add(task);
    void task.finally(() => {
      this.deliveryCallbackInFlight.delete(task);
    }).catch(() => {});
    return task;
  }

  async closeSession(subscriptionId, expectedSession = null) {
    const session = this.deliverySessions.get(subscriptionId);
    if (!session || (expectedSession && session !== expectedSession)) return false;
    this.deliverySessions.delete(subscriptionId);
    try {
      if (typeof session.close === 'function') await session.close();
    } catch {
      // Closing stale delivery sessions is best effort.
    }
    return true;
  }

  async detachConnection(connectionId) {
    this.assertOpen();
    const pending = this.detachConnectionUnchecked(connectionId);
    this.detachInFlight.add(pending);
    try {
      return await pending;
    } finally {
      this.detachInFlight.delete(pending);
    }
  }

  queueAuthorityRevocation(connection) {
    if(!connection?.authorityEpoch)return null;
    const key=JSON.stringify([
      connection.scopeId,connection.connectionId,connection.authorityEpoch,
    ]);
    if(!this.pendingAuthorityRevocations.has(key)) {
      this.pendingAuthorityRevocations.set(key,connection);
    }
    return key;
  }

  async flushAuthorityRevocations() {
    // Continue attempting healthy independent scopes after one failed scope.
    // A failure must never be treated as success or discarded from the
    // retry queue. Only successfully processed keys are removed.
    const failures=[];
    for(const [key,connection] of [...this.pendingAuthorityRevocations]) {
      try {
        const context=await this.scopeContext(connection);
        if(typeof context.store.revokeMcpConnectionAuthority!=='function') {
          throw new Error('Missing shared MCP authority revocation capability');
        }
        await context.store.revokeMcpConnectionAuthority({
          connectionId:connection.connectionId,epoch:connection.authorityEpoch,
        });
        this.pendingAuthorityRevocations.delete(key);
      }catch {
        failures.push(key);
      }
    }
    if(failures.length) {
      const error=new Error('MCP session revocations incomplete; retry host shutdown');
      error.code='MCP_SESSION_REVOCATION_INCOMPLETE';
      throw error;
    }
  }

  async detachConnectionUnchecked(connectionId) {
    // Revoke authority synchronously. Reserve cleanup in the *same* durable
    // mutation queue before the first await, so new sessions cannot discover
    // sources or persist cursors ahead of the old disable operation.
    const connection = this.connections.get(connectionId);
    const removed = this.connections.delete(connectionId);
    const authorityKey = removed ? this.queueAuthorityRevocation(connection) : null;
    const cleanup = removed
      ? this.withConnectionMutation(connectionId, async () => {
          const context = await this.scopeContext(connection);
          if(authorityKey) {
            if(typeof context.store.revokeMcpConnectionAuthority!=='function') {
              throw new Error('Host MCP connection authority fence unavailable');
            }
            await context.store.revokeMcpConnectionAuthority({
              connectionId,epoch:connection.authorityEpoch,
            });
            this.pendingAuthorityRevocations.delete(authorityKey);
          }
          const sources = await context.store.listEventSources({
            connectionIds: [connectionId],
          });
          for (const source of sources) {
            if (source.enabled === false) continue;
            const register = context.triggerControl?.registerEventSource
              ? (input, actor) =>
                  context.triggerControl.registerEventSource(input, actor)
              : async (input) => this.registerEventSource(input);
            await register(
              { ...source, enabled: false },
              {
                type: 'system',
                principal_id: 'event-intelligence:host-mcp-client',
              },
            );
          }
        })
      : Promise.resolve();
    const timer = this.timers.get(connectionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(connectionId);
    this.descriptors.delete(connectionId);
    this.profiles.delete(connectionId);
    this.lastErrors.delete(connectionId);
    this.pollInFlight.delete(connectionId);

    // Snapshot ONLY sessions owned by this connection object. Async close
    // must never visit or remove replacement sessions registered mid-cleanup.
    const previousSessions = [...this.deliverySessions].filter(
      ([, session]) => session.connection === connection,
    );
    // Register the removable listener BEFORE invoking any host-owned
    // session hook; that hook can synchronously reenter host.close().
    let shutdownTimer;
    let detachSettled = false;
    let signalShutdown;
    const shutdownGrace = new Promise(resolve => {
      signalShutdown = () => {
        if (detachSettled || shutdownTimer) return;
        shutdownTimer = setTimeout(resolve, 500);
      };
      this.shutdownListeners.add(signalShutdown);
      if (this.closed) signalShutdown();
    });
    const sessionTeardown = Promise.all(previousSessions.map(([id,session]) =>
      this.closeSession(id,session)
    ));
    // Ordinary detach awaits the provider hook. Only a concurrent global
    // shutdown makes bounded best-effort teardown eligible.
    try {
      await Promise.race([sessionTeardown, shutdownGrace]);
    } finally {
      detachSettled = true;
      this.shutdownListeners.delete(signalShutdown);
      clearTimeout(shutdownTimer);
    }
    try {
      await cleanup;
    } finally {
      const key = `${connection?.connectionId}::${connection?.scopeId}`;
      // Scope contexts are keyed by ID+scope, and may already be reused by
      // a replacement. Never clear a context while a replacement is live.
      if (connection && !this.connections.has(connectionId)) {
        this.scopeContexts.delete(key);
      }
    }
    return removed;
  }

  // Provider-owned hooks may reject with arbitrary private payloads or
  // credential-bearing exceptions. Never expose raw thrown objects beyond
  // this boundary, including capability lookup and stream setup.
  async invokeProvider(operation) {
    try {
      return await operation();
    } catch (untrustedError) {
      const terminal = classifyTerminalMcpProviderError(untrustedError);
      const failure = new Error(PROVIDER_ERROR_MESSAGE);
      failure.code = 'MCP_EVENTS_PROVIDER_REQUEST_FAILED';
      // Copy only fixed strings derived from validated numeric/code fields.
      // Never preserve the producer's Error, message, cause or data object.
      if (terminal) {
        failure.terminalReason = terminal.reason;
        failure.terminalScope = terminal.scope;
      }
      throw failure;
    }
  }

  async rpc(connection, method, params) {
    return this.invokeProvider(() => connection.request(method, params));
  }

  async discoverConnection(connectionId) {
    this.assertOpen();
    const connection = this.connections.get(connectionId);
    if (!connection) {
      throw new Error(
        `Unknown host-managed MCP Events connection: ${connectionId}`,
      );
    }

    const context = await this.scopeContext(connection);
    this.assertOpen();
    const capabilities = await this.invokeProvider(async () =>
      safeMcpCapabilities(await connection.getCapabilities()),
    );
    this.assertOpen();
    this.assertConnectionAttached(connection);
    const profile = resolveMcpEventsCompatibilityProfile({
      capabilities,
      requested: connection.compatibilityProfile,
    });
    if (!profile) {
      const expected = getMcpEventsCompatibilityProfile(
        connection.compatibilityProfile,
      );
      const error = new Error(
        `MCP server ${connectionId} does not advertise the ${expected.id} Events profile`,
      );
      error.code = 'MCP_EVENTS_CAPABILITY_UNAVAILABLE';
      throw error;
    }

    const descriptors = [];
    const names = new Set();
    const seenCursors = new Set();
    let pageCount = 0;
    let cursor = null;
    do {
      if (++pageCount > MAX_MCP_EVENT_DISCOVERY_PAGES) {
        throw discoveryLimitError('too many events/list pages');
      }
      const rawPage = await this.rpc(
        connection,
        profile.listMethod,
        cursor ? { cursor } : {},
      );
      this.assertOpen();
      this.assertConnectionAttached(connection);
      const listed = ownDiscoveryPage(rawPage, connectionId);
      // Validate the *original* cursor shape and cycle before parsing any
      // untrusted descriptor on this page. Never coerce objects/arrays with
      // String(): doing so can allocate huge strings and fabricate cursors.
      const rawNextCursor = listed?.nextCursor;
      if (rawNextCursor !== undefined && rawNextCursor !== null &&
          typeof rawNextCursor !== 'string') {
        const error = new Error(
          'MCP Events discovery rejected: invalid events/list cursor type',
        );
        error.code = 'MCP_EVENTS_DISCOVERY_CURSOR_INVALID';
        throw error;
      }
      const nextCursor = rawNextCursor || null;
      if (nextCursor) {
        if (Buffer.byteLength(nextCursor, 'utf8') > MAX_MCP_EVENT_CURSOR_BYTES) {
          throw discoveryLimitError('events/list cursor too long');
        }
        if (seenCursors.has(nextCursor)) {
          throw discoveryLimitError('events/list cursor cycle');
        }
        seenCursors.add(nextCursor);
      }
      if (listed.events.length >
        MAX_MCP_EVENT_DISCOVERY_SOURCES - descriptors.length) {
        throw discoveryLimitError('too many event descriptors');
      }
      // Copy ONLY the permitted own indexed slots, not arbitrary extra
      // array metadata. Object.getOwnPropertyDescriptors(listed.events)
      // could enumerate unbounded non-index keys despite the length cap.
      // This indexed staging buffer is bounded by the 256-source limit.
      const indexedDescriptors = [];
      for (let index = 0; index < listed.events.length; index += 1) {
        const slot = Object.getOwnPropertyDescriptor(
          listed.events, String(index),
        );
        if (!slot || !Object.hasOwn(slot, 'value')) {
          const error = new Error(
            'MCP Events discovery rejected: unsafe descriptor array slot',
          );
          error.code = 'EVENT_UNTRUSTED_DATA_INVALID';
          throw error;
        }
        indexedDescriptors.push(stageDiscoveryDescriptor(slot.value));
      }
      // A single bounded walk now deeply snapshots only the six consumed
      // top-level descriptor fields, not arbitrary producer metadata keys.
      // Nested advertised schema and _meta bodies remain semantically
      // relevant and need host-owned transport response-byte limits.
      const safeDescriptors = snapshotUntrustedEventData(indexedDescriptors);
      assertDecodedMcpBytes(safeDescriptors, connection.maxDiscoveryBytes, 'discovery');
      for (const raw of safeDescriptors) {
        const descriptor = sourceDescriptor(raw, profile);
        if (names.has(descriptor.name)) {
          // The descriptor name is producer-controlled and may contain
          // sensitive event data. Never reflect it in host-visible errors.
          const error = new Error('MCP Events discovery rejected: duplicate event descriptor');
          error.code = 'MCP_EVENTS_DUPLICATE_DESCRIPTOR_NAME';
          throw error;
        }
        names.add(descriptor.name);
        descriptors.push(descriptor);
      }
      cursor = nextCursor;
    } while (cursor);

    for (const normalized of descriptors) {
      this.assertOpen();
      await this.withConnectionMutation(connectionId, async () => {
        this.assertOpen();
        this.assertConnectionAttached(connection);
        const sourceId =
        `mcp:${connection.connectionId}:${normalized.name}`;
      const existing = (
        await context.store.listEventSources()
      ).find((source) => source.sourceId === sourceId);
      const same =
        existing &&
        existing.enabled !== false &&
        existing.connectionId === connection.connectionId &&
        existing.serverId === connection.serverId &&
        existing.eventName === normalized.name &&
        JSON.stringify(existing.delivery) ===
          JSON.stringify(normalized.delivery) &&
        JSON.stringify(existing.inputSchema || {}) ===
          JSON.stringify(normalized.inputSchema) &&
        JSON.stringify(existing.payloadSchema || {}) ===
          JSON.stringify(normalized.payloadSchema) &&
        existing.metadata?.compatibilityProfile === profile.id &&
        existing.metadata?.extensionId === profile.extensionId;

      if (!same) {
        this.assertOpen();
        this.assertConnectionAttached(connection);
        const register = context.triggerControl?.registerEventSource
          ? (sourceInput, actor) =>
              context.triggerControl.registerEventSource(sourceInput, actor)
          : async (sourceInput) => this.registerEventSource(sourceInput);
        await register(
          {
            sourceId,
            connectionId: connection.connectionId,
            serverId: connection.serverId,
            eventName: normalized.name,
            description: normalized.description,
            delivery: normalized.delivery,
            inputSchema: normalized.inputSchema,
            payloadSchema: normalized.payloadSchema,
            enabled: true,
            experimental: true,
            metadata: {
              transport: 'host-managed-mcp',
              hostManaged: true,
              extensionId: profile.extensionId,
              compatibilityProfile: profile.id,
              ...(normalized._meta ? { descriptorMeta: normalized._meta } : {}),
            },
          },
          {
            type: 'system',
            principal_id: 'event-intelligence:host-mcp-client',
          },
        );
      }
        this.assertConnectionAttached(connection);
      });
    }

    this.assertConnectionAttached(connection);
    this.descriptors.set(connection.connectionId, descriptors);
    this.profiles.set(connection.connectionId, profile);
    this.lastErrors.delete(connection.connectionId);
    return descriptors;
  }

  async discoverAll() {
    const results = [];
    for (const connection of this.connections.values()) {
      try {
        const events = await this.discoverConnection(connection.connectionId);
        results.push({
          connectionId: connection.connectionId,
          status: 'ready',
          events: events.map((event) => event.name),
        });
      } catch (error) {
        const unavailable = isUnavailableCapability(error);
        const message = safeMcpFailure(error);
        if (this.isConnectionAttached(connection)) {
          this.lastErrors.set(connection.connectionId, message);
        }
        results.push({
          connectionId: connection.connectionId,
          status: unavailable ? 'ignored_no_events' : 'error',
          ...(unavailable ? {} : { error: message }),
        });
      }
    }
    return results;
  }

  async desiredSubscriptions(connection, context) {
    const descriptors = this.descriptors.get(connection.connectionId) || [];
    const byName = new Map(descriptors.map((item) => [item.name, item]));
    const desired = new Map();
    let triggers = [];
    if (typeof context.triggerControl?.listTriggers === 'function') {
      triggers = await context.triggerControl.listTriggers();
    } else if (typeof context.store?.listTriggers === 'function') {
      const definitions = await context.store.listTriggers();
      triggers = await Promise.all(definitions.map(async (definition) => ({
        definition,
        state:
          typeof context.store.getTriggerState === 'function'
            ? await context.store.getTriggerState(
              definition.triggerId,
              definition.version,
            )
            : null,
      })));
    }

    for (const { definition, state } of triggers) {
      if (state?.status !== 'active') continue;
      for (const clause of definition.clauses ?? []) {
        if (clause.serverId !== connection.serverId) continue;
        const descriptor = byName.get(clause.event);
        if (!descriptor) continue;
        const args =
          clause.arguments &&
          !Array.isArray(clause.arguments) &&
          typeof clause.arguments === 'object'
            ? clause.arguments
            : {};
        const subscriptionId = eventSubscriptionId(
          connection.connectionId,
          clause.event,
          args,
        );
        const consumerRef =
          `${definition.triggerId}@${definition.version}:${clause.id}`;
        const existing = desired.get(subscriptionId);
        if (existing) {
          existing.consumerRefs.push(consumerRef);
        } else {
          desired.set(subscriptionId, {
            subscriptionId,
            eventName: clause.event,
            arguments: args,
            descriptor,
            consumerRefs: [consumerRef],
          });
        }
      }
    }

    return desired;
  }

  async ingestOccurrence(connection, context, subscription, raw) {
    // Do not even parse untrusted payloads from a revoked/replaced session.
    if (!this.isConnectionAttached(connection)) {
      return { accepted: false, reason: 'detached' };
    }
    const descriptor = subscription.descriptor;
    // For push/webhook and poll alike, reject oversized decoded event bytes
    // BEFORE append, durable cursor advancement or consumer activation.
    assertDecodedMcpBytes(raw, connection.maxOccurrenceBytes, 'occurrence');
    const occurrence = McpEventOccurrenceSchema.parse(raw);
    if (occurrence.name !== descriptor.name) {
      // Both descriptor and occurrence names originate from the MCP provider.
      // Never interpolate their values into operator-visible error strings:
      // they can carry arbitrary private or attacker-controlled text.
      const error = new Error('MCP Events occurrence does not match subscription');
      error.code = 'MCP_EVENTS_OCCURRENCE_NAME_MISMATCH';
      throw error;
    }
    assertJsonSchemaValue(descriptor.payloadSchema, occurrence.data);

    const receivedAt = this.now().toISOString();
    // Track BEFORE the first storage await. A concurrent detach may remove
    // the connection-ID poll slot; this task is still an admitted append
    // and must finish or fail before host shutdown releases the store.
    const processing = (async () => {
      const receipt = await context.store.appendMcpOccurrence(
        connection.serverId,
        occurrence,
        subscription.subscriptionId,
        connection.authorityEpoch
          ? {connectionId:connection.connectionId,epoch:connection.authorityEpoch}
          : null,
      );
      if (!receipt.accepted) return { accepted: false, occurrence };
      // Pre-revoke durably accepted work must complete CEP, otherwise a
      // stored dedup ID could strand the event permanently on replay.
      // New work, stale cursors and host effect authority remain fenced.
      await context.compositeEventConsumer.ingestMcpOccurrence({
        event: occurrence,
        serverId: connection.serverId,
        provider: 'mcp',
        traceId:
          `mcp:${connection.serverId}:${subscription.subscriptionId}:${occurrence.eventId}`,
        subscriptionArguments: subscription.arguments,
        receivedAt,
      });
      return { accepted: true, occurrence };
    })();
    this.occurrenceInFlight.add(processing);
    try {
      return await processing;
    } finally {
      this.occurrenceInFlight.delete(processing);
    }
  }

  async saveSubscriptionState(
    connection,
    context,
    subscription,
    patch = {},
  ) {
    // Serialize both read and write with source registration and detach.
    // An already-started old put finishes BEFORE new-session cursor writes,
    // while a not-yet-started old operation rejects after revoke.
    return this.withConnectionMutation(connection.connectionId, async () => {
      this.assertConnectionAttached(connection);
      const previous = await context.store.getMcpClientState(
        connection.connectionId,
        subscription.eventName,
        subscription.arguments,
      );
      this.assertConnectionAttached(connection);
      return context.store.putMcpClientState({
        ...(previous || {}),
        connectionId: connection.connectionId,
        serverId: connection.serverId,
        eventName: subscription.eventName,
        arguments: subscription.arguments,
        subscriptionId: subscription.subscriptionId,
        ...patch,
      });
    });
  }

  async pollSubscription(
    connection,
    context,
    subscription,
    { respectSchedule = false } = {},
  ) {
    this.assertConnectionAttached(connection);
    const suspended = this.terminalPollSubscriptions
      .get(connection)?.get(subscription.subscriptionId);
    if (suspended || this.terminalConnections.has(connection)) {
      return {
        subscriptionId: subscription.subscriptionId,
        eventName: subscription.eventName,
        delivery: 'poll',
        status: 'terminal',
        reason: this.terminalConnections.has(connection)
          ? 'forbidden' : suspended,
        accepted: 0,
        consumerCount: subscription.consumerRefs.length,
      };
    }
    const store = context.store;
    const current = await store.getMcpClientState(
      connection.connectionId,
      subscription.eventName,
      subscription.arguments,
    );
    if (
      respectSchedule &&
      current?.nextPollAt &&
      Date.parse(current.nextPollAt) > this.now().getTime()
    ) {
      return {
        subscriptionId: subscription.subscriptionId,
        eventName: subscription.eventName,
        delivery: 'poll',
        status: 'scheduled',
        accepted: 0,
        consumerCount: subscription.consumerRefs.length,
        cursor: current.cursor,
        nextPollAt: current.nextPollAt,
      };
    }

    let cursor = current?.cursor ?? null;
    let lastEventAt = current?.lastEventAt;
    let accepted = 0;
    let batches = 0;
    let hasMore = false;
    let truncated = false;
    let nextPollMs = connection.pollIntervalMs;

    do {
      const profile =
        this.profiles.get(connection.connectionId) ??
        getMcpEventsCompatibilityProfile(connection.compatibilityProfile);
      let rawResult;
      try {
        rawResult = await this.rpc(connection, profile.pollMethod, {
          name: subscription.eventName,
          arguments: subscription.arguments,
          cursor,
          maxEvents: connection.maxEvents,
        });
      } catch (error) {
        this.assertConnectionAttached(connection);
        if (error?.terminalReason === 'forbidden') {
          this.terminalConnections.add(connection);
        } else if (error?.terminalReason === 'not_found') {
          let perConnection = this.terminalPollSubscriptions.get(connection);
          if (!perConnection) {
            perConnection = new Map();
            this.terminalPollSubscriptions.set(connection, perConnection);
          }
          perConnection.set(subscription.subscriptionId, 'not_found');
        } else {
          throw error;
        }
        return {
          subscriptionId: subscription.subscriptionId,
          eventName: subscription.eventName,
          delivery: 'poll',
          status: 'terminal',
          reason: error.terminalReason,
          // Earlier pages in this same bounded sweep may already have
          // committed matches and durable cursor checkpoints.
          accepted,
          batches,
          cursor,
          truncated,
          consumerCount: subscription.consumerRefs.length,
        };
      }
      // Do not process an RPC response which completed after detach or after
      // another session replaced this connectionId.
      this.assertConnectionAttached(connection);
      // The producer has already declared missing history. Persist that
      // fact BEFORE ANY subsequent page validation: bad event arrays,
      // cursors or scheduling hints cannot silently erase a reported gap.
      // Read only a non-Proxy own DATA property (never invoke getters).
      if (rawResult && typeof rawResult === 'object' &&
          !isProxy(rawResult)) {
        const reportedGap=Object.getOwnPropertyDescriptor(
          rawResult,'truncated',
        );
        if (reportedGap && Object.hasOwn(reportedGap,'value') &&
            reportedGap.value === true) {
          await this.saveSubscriptionState(connection,context,subscription,{
            deliveryMode:'poll',
            truncated:true,
            gapDetectedAt:this.now().toISOString(),
          });
        }
      }
      const result = ownPollPage(rawResult);
      const remoteEvents = result.events;
      // A producer adapter can return a Proxy, accessor-backed array or a
      // custom iterator, not just wire-decoded JSON. Snapshot the bounded
      // OWN entries before the first async append; the remote array cannot
      // grow under our feet, yield extra records or mutate later payloads.
      if (isProxy(remoteEvents) || !Array.isArray(remoteEvents)) {
        throw new Error(
          `MCP server ${connection.connectionId} returned invalid events/poll`,
        );
      }
      // maxEvents is a PER-PAGE hard limit, not merely a provider hint.
      if (remoteEvents.length > connection.maxEvents) {
        const error = new Error(
          'MCP Events poll page exceeds configured maxEvents',
        );
        error.code = 'MCP_EVENTS_POLL_BATCH_LIMIT_EXCEEDED';
        throw error;
      }
      const boundedEvents = [];
      let decodedPageBytes = 2; // JSON array brackets
      for (let index = 0; index < remoteEvents.length; index += 1) {
        const slot = Object.getOwnPropertyDescriptor(remoteEvents, String(index));
        if (!slot || !Object.hasOwn(slot, 'value')) {
          const error = new Error(
            'MCP Events poll page contains unsafe array elements',
          );
          error.code = 'MCP_EVENTS_POLL_BATCH_INVALID';
          throw error;
        }
        // Existing own-data JSON snapshot rejects nested getters, proxies
        // and cycles without executing hostile JavaScript, before any write.
        const event = snapshotUntrustedEventData(slot.value);
        const eventBytes = assertDecodedMcpBytes(
          event, connection.maxOccurrenceBytes, 'occurrence',
        );
        decodedPageBytes += eventBytes + (index === 0 ? 0 : 1);
        if (decodedPageBytes > connection.maxPollPageBytes) {
          const error = new Error('MCP Events decoded input exceeds configured byte budget');
          error.code = 'MCP_EVENTS_DECODED_BYTE_LIMIT_EXCEEDED';
          error.kind = 'poll-page';
          throw error;
        }
        boundedEvents.push(event);
      }
      cursor = normalizeCursor(
        result.cursor,
        `MCP server ${connection.connectionId} events/poll`,
      );
      hasMore = result.hasMore === true;
      if (hasMore && cursor === null) {
        const error = new Error('MCP Events poll backlog requires a continuation cursor');
        error.code = 'MCP_EVENTS_POLL_CURSOR_INVALID';
        throw error;
      }
      truncated = truncated || result.truncated === true;
      const producerNextPollMs = normalizeNextPollMs(
        result.nextPollMs,
        connection.pollIntervalMs,
      );
      nextPollMs = hasMore
        ? producerNextPollMs
        : Math.max(connection.pollFloorMs, producerNextPollMs);

      for (const raw of boundedEvents) {
        const receipt = await this.ingestOccurrence(
          connection,
          context,
          subscription,
          raw,
        );
        if (!receipt.accepted) continue;
        accepted += 1;
        lastEventAt = receipt.occurrence.timestamp;
      }

      batches += 1;
      const nextPollAt = new Date(
        this.now().getTime() + (hasMore ? 0 : nextPollMs),
      ).toISOString();
      this.assertConnectionAttached(connection);
      await this.saveSubscriptionState(
        connection,
        context,
        subscription,
        {
          deliveryMode: 'poll',
          cursor,
          truncated,
          ...(truncated ? { gapDetectedAt: this.now().toISOString() } : {}),
          nextPollAt,
          ...(lastEventAt ? { lastEventAt } : {}),
        },
      );
    } while (hasMore && batches < connection.maxPollBatches);

    if (this.isConnectionAttached(connection)) {
      this.lastErrors.delete(connection.connectionId);
    }
    return {
      subscriptionId: subscription.subscriptionId,
      eventName: subscription.eventName,
      delivery: 'poll',
      status: 'ok',
      accepted,
      consumerCount: subscription.consumerRefs.length,
      cursor,
      truncated,
      hasMore,
      batches,
      nextPollMs,
      batchLimitReached: hasMore && batches >= connection.maxPollBatches,
    };
  }

  async ensureDeliverySession(
    connection,
    context,
    subscription,
    delivery,
  ) {
    this.assertOpen();
    this.assertConnectionAttached(connection);
    const existing = this.deliverySessions.get(subscription.subscriptionId);
    if (existing?.delivery === delivery && existing.connection === connection) {
      return {
        subscriptionId: subscription.subscriptionId,
        eventName: subscription.eventName,
        delivery,
        status: 'active',
        accepted: existing.accepted,
        consumerCount: subscription.consumerRefs.length,
      };
    }
    if (existing) await this.closeSession(subscription.subscriptionId, existing);
    this.assertConnectionAttached(connection);

    const current = await context.store.getMcpClientState(
      connection.connectionId,
      subscription.eventName,
      subscription.arguments,
    );
    this.assertConnectionAttached(connection);
    let accepted = 0;
    let activeSession = null;
    let terminatedDuringOpen = false;

    // Push and webhook transport callbacks are still untrusted ingress.
    // Like bounded poll pages, take an own-data JSON snapshot synchronously
    // before any parser, async store append or later cursor access. A provider
    // cannot use getters/proxies or mutate a queued payload after this point.
    const onEvent = async (raw) => {
      if (!this.isConnectionAttached(connection)) return;
      const safeEvent = snapshotUntrustedEventData(raw);
      assertDecodedMcpBytes(safeEvent, connection.maxOccurrenceBytes, 'occurrence');
      // Reject an invalid cursor before any durable append. Otherwise the
      // event could be accepted but its continuation point be uncommittable.
      const hasCursor = Object.hasOwn(safeEvent ?? {}, 'cursor');
      const eventCursor = hasCursor
        ? normalizeCursor(
            safeEvent.cursor,
            `${delivery} event ${subscription.eventName}`,
          )
        : null;
      this.assertConnectionAttached(connection);
      const receipt = await this.ingestOccurrence(
        connection,
        context,
        subscription,
        safeEvent,
      );
      if (!this.isConnectionAttached(connection)) return;
      if (receipt.accepted) accepted += 1;
      if (hasCursor) {
        await this.saveSubscriptionState(
          connection,
          context,
          subscription,
          {
            deliveryMode: delivery,
            cursor: eventCursor,
            ...(receipt.accepted
              ? { lastEventAt: receipt.occurrence.timestamp }
              : {}),
          },
        );
      }
    };

    const safeCallbackUpdate = (raw = {}) => {
      const update = snapshotUntrustedEventData(raw ?? {});
      assertDecodedMcpBytes(update, connection.maxOccurrenceBytes, 'callback-update');
      if (!update || Array.isArray(update) || typeof update !== 'object') {
        const error = new TypeError('MCP Events callback update must be a JSON object');
        error.code = 'EVENT_UNTRUSTED_DATA_INVALID';
        throw error;
      }
      return update;
    };

    const onActive = async (raw = {}) => {
      if (!this.isConnectionAttached(connection)) return;
      const update = safeCallbackUpdate(raw);
      this.assertConnectionAttached(connection);
      const patch = {
        deliveryMode: delivery,
        ...(Object.hasOwn(update, 'cursor')
          ? {
              cursor: normalizeCursor(
                update.cursor,
                `${delivery} active ${subscription.eventName}`,
              ),
            }
          : {}),
        ...(typeof update.truncated === 'boolean'
          ? { truncated: update.truncated,
              ...(update.truncated
                ? { gapDetectedAt: this.now().toISOString() } : {}) }
          : {}),
      };
      await this.saveSubscriptionState(
        connection,
        context,
        subscription,
        patch,
      );
    };

    const onGap = async (raw = {}) => {
      if (!this.isConnectionAttached(connection)) return;
      const update = safeCallbackUpdate(raw);
      await onActive({ ...update, truncated: true });
    };

    const onError = (error) => {
      if (!this.isConnectionAttached(connection)) return;
      this.lastErrors.set(connection.connectionId, PROVIDER_ERROR_MESSAGE);
      void this.observability?.emit({
        event: 'ei.source.delivery_failed',
        level: 'warn',
        scopeId: connection.scopeId,
        connectionId: connection.connectionId,
        serverId: connection.serverId,
        // Untrusted descriptor names cannot enter operational telemetry.
        error: new Error(PROVIDER_ERROR_MESSAGE),
      });
    };

    const onTerminated = async (detail) => {
      terminatedDuringOpen = true;
      if (!this.isConnectionAttached(connection) ||
          !activeSession ||
          this.deliverySessions.get(subscription.subscriptionId) !== activeSession) return;
      this.deliverySessions.delete(subscription.subscriptionId);
      if (detail) {
        this.lastErrors.set(connection.connectionId, PROVIDER_ERROR_MESSAGE);
      }
      void this.observability?.emit({
        event: 'ei.source.delivery_terminated',
        level: detail ? 'warn' : 'debug',
        scopeId: connection.scopeId,
        connectionId: connection.connectionId,
        serverId: connection.serverId,
        // Avoid arbitrary unlabelled provider names in diagnostics.
        status: 'terminated',
      });
    };

    const open =
      delivery === 'push'
        ? connection.openEventStream
        : connection.createWebhookSubscription;
    const projectedHandle = await this.invokeProvider(async () =>
      projectDeliveryHandle(await open({
        subscriptionId: subscription.subscriptionId,
        name: subscription.eventName,
        arguments: subscription.arguments,
        cursor: current?.cursor ?? null,
        // Never expose raw unguarded callbacks to a provider that can
        // retain them after the host destroys its sessions.
        onEvent: value => this.trackDeliveryCallback(() => onEvent(value)),
        onActive: value => this.trackDeliveryCallback(() => onActive(value)),
        onGap: value => this.trackDeliveryCallback(() => onGap(value)),
        onError: value => {
          if (!this.closed) onError(value);
        },
        onTerminated: value => this.trackDeliveryCallback(() => onTerminated(value)),
      })),
    );
    const close = projectedHandle.close;

    const detachedOutcome = () => ({
      subscriptionId: subscription.subscriptionId,
      eventName: subscription.eventName,
      delivery,
      status: 'detached',
      accepted: 0,
      consumerCount: subscription.consumerRefs.length,
    });
    const cleanupOrphan = async () => {
      try { await close(); } catch {
        // Cleanup is best effort; callbacks are independently fenced.
      }
    };

    try {
      if (!this.isConnectionAttached(connection) || terminatedDuringOpen) {
        await cleanupOrphan();
        return detachedOutcome();
      }
      if (projectedHandle.hasCursor) {
        await onActive({
          cursor: projectedHandle.cursor,
          truncated: projectedHandle.truncated,
        });
      } else {
        await this.saveSubscriptionState(
          connection,
          context,
          subscription,
          {
            deliveryMode: delivery,
            cursor: current?.cursor ?? null,
          },
        );
      }
      // State initialization itself is async. Revoke may have happened
      // while it was running, even though stream opening was authorized.
      if (!this.isConnectionAttached(connection) || terminatedDuringOpen) {
        await cleanupOrphan();
        return detachedOutcome();
      }

      activeSession = {
        connection,
        connectionId: connection.connectionId,
        delivery,
        close,
        get accepted() { return accepted; },
      };
      this.deliverySessions.set(subscription.subscriptionId, activeSession);
      this.lastErrors.delete(connection.connectionId);

      return {
        subscriptionId: subscription.subscriptionId,
        eventName: subscription.eventName,
        delivery,
        status: 'active',
        accepted,
        consumerCount: subscription.consumerRefs.length,
      };
    } catch (error) {
      await cleanupOrphan();
      if (error?.code === 'MCP_EVENTS_CONNECTION_DETACHED') {
        return detachedOutcome();
      }
      throw error;
    }
  }

  async reconcileDeliverySessions(connection, desiredIds) {
    this.assertConnectionAttached(connection);
    for (const [subscriptionId, session] of this.deliverySessions) {
      if (
        session.connection === connection &&
        !desiredIds.has(subscriptionId)
      ) {
        await this.closeSession(subscriptionId, session);
      }
    }
  }

  /**
   * Host-only explicit reconciliation after independently verified replay.
   * Never exposed as an MCP tool or callable from a provider notification.
   * An opaque cursor advancing is NOT evidence of replay completeness.
   */
  async acknowledgeReconciledGap(input) {
    this.assertOpen();
    const pending = this.acknowledgeReconciledGapUnchecked(input);
    this.reconciliationInFlight.add(pending);
    try {
      return await pending;
    } finally {
      this.reconciliationInFlight.delete(pending);
    }
  }

  async acknowledgeReconciledGapUnchecked({
    connectionId, eventName, arguments: args = {}, evidenceId,
    expectedCompletenessRevision,
  }) {
    if(typeof evidenceId !== 'string' || !evidenceId.trim() ||
       evidenceId.length > 256) {
      throw new Error('Host reconciliation requires an evidence ID');
    }
    // A host receipt must be tied to the exact gap generation it verified.
    if (!Number.isSafeInteger(expectedCompletenessRevision) ||
        expectedCompletenessRevision < 0) {
      throw new Error('Host reconciliation requires expected completeness revision');
    }
    const connection=this.connections.get(connectionId);
    if(!connection) throw new Error('Unknown host-managed connection');
    this.assertConnectionAttached(connection);
    const context=await this.scopeContext(connection);
    this.assertConnectionAttached(connection);
    return this.withConnectionMutation(connectionId,async()=>{
      this.assertConnectionAttached(connection);
      const previous=await context.store.getMcpClientState(
        connectionId,eventName,args,
      );
      if(!previous || previous.serverId!==connection.serverId ||
         !(previous.gapUnresolved===true || previous.truncated===true)) {
        throw new Error('No unresolved gap for the attached source');
      }
      this.assertConnectionAttached(connection);
      return context.store.putMcpClientState({
        ...previous, connectionId, serverId:connection.serverId,
        eventName,arguments:args,gapReconciled:true,
        expectedCompletenessRevision,
        reconciliationEvidenceId:evidenceId,
        truncated:false,
      });
    });
  }

  async pollConnection(connectionId, options = {}) {
    this.assertOpen();
    const existing = this.pollInFlight.get(connectionId);
    if (existing) return existing;

    const task = this.pollConnectionOnce(connectionId, options);
    this.pollInFlight.set(connectionId, task);
    try {
      return await task;
    } finally {
      if (this.pollInFlight.get(connectionId) === task) {
        this.pollInFlight.delete(connectionId);
      }
    }
  }

  async pollConnectionOnce(
    connectionId,
    { respectSchedule = false } = {},
  ) {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      throw new Error(
        `Unknown host-managed MCP Events connection: ${connectionId}`,
      );
    }

    this.assertConnectionAttached(connection);
    // A validated Forbidden revokes the current connection's polling
    // authority. Only a fresh host-owned attachment may probe again.
    if (this.terminalConnections.has(connection)) {
      return [{ status: 'terminal', reason: 'forbidden',
        delivery: 'poll', accepted: 0 }];
    }
    const context = await this.scopeContext(connection);
    this.assertConnectionAttached(connection);
    let descriptors = this.descriptors.get(connectionId);
    if (!descriptors) {
      descriptors = await this.discoverConnection(connectionId);
    }

    const desired = await this.desiredSubscriptions(connection, context);
    const desiredIds = new Set(desired.keys());
    // Trigger definitions and subscription argument sets can churn forever.
    // Forget terminal IDs no longer desired so a long-lived connection
    // cannot accumulate an unbounded quarantine cache.
    const suspended = this.terminalPollSubscriptions.get(connection);
    if (suspended) {
      for (const id of suspended.keys()) {
        if (!desiredIds.has(id)) suspended.delete(id);
      }
    }
    const results = [];

    for (const subscription of desired.values()) {
      this.assertConnectionAttached(connection);
      if (this.terminalConnections.has(connection)) {
        results.push({
          subscriptionId: subscription.subscriptionId,
          eventName: subscription.eventName,
          status: 'terminal',
          reason: 'forbidden',
          delivery: 'poll',
          accepted: 0,
          consumerCount: subscription.consumerRefs.length,
        });
        continue;
      }
      const delivery = chooseDelivery(connection, subscription.descriptor);
      if (!delivery) {
        results.push({
          subscriptionId: subscription.subscriptionId,
          eventName: subscription.eventName,
          status: 'delivery_not_supported',
          delivery: null,
          accepted: 0,
          consumerCount: subscription.consumerRefs.length,
        });
        continue;
      }

      if (delivery === 'poll') {
        await this.closeSession(subscription.subscriptionId);
        results.push(
          await this.pollSubscription(
            connection,
            context,
            subscription,
            { respectSchedule },
          ),
        );
      } else {
        results.push(
          await this.ensureDeliverySession(
            connection,
            context,
            subscription,
            delivery,
          ),
        );
      }
    }

    this.assertConnectionAttached(connection);
    await this.reconcileDeliverySessions(connection, desiredIds);
    return results;
  }

  async pollAll(options = {}) {
    const results = [];
    for (const connection of this.connections.values()) {
      try {
        results.push({
          connectionId: connection.connectionId,
          results: await this.pollConnection(
            connection.connectionId,
            options,
          ),
        });
      } catch (error) {
        const message = safeMcpFailure(error);
        this.lastErrors.set(connection.connectionId, message);
        await this.observability?.emit({
          event: 'ei.source.poll_failed',
          level: 'warn',
          scopeId: connection.scopeId,
          connectionId: connection.connectionId,
          serverId: connection.serverId,
          error: new Error(message),
        });
        results.push({
          connectionId: connection.connectionId,
          error: message,
        });
      }
    }
    return results;
  }

  async nextDelay(connection) {
    const context = this.scopeContexts.get(
      `${connection.connectionId}::${connection.scopeId}`,
    );
    if (!context) return connection.pollIntervalMs;
    const states = await context.store.listMcpClientStates(
      connection.connectionId,
    );
    const suspended = this.terminalPollSubscriptions.get(connection);
    const now = this.now().getTime();
    const due = states
      .filter((state) => !suspended?.has(state.subscriptionId))
      .map((state) => Date.parse(state.nextPollAt || ''))
      .filter(Number.isFinite)
      // The producer floor was already applied when persisting nextPollAt.
      // A restart just before its deadline must honor the *remaining* time;
      // do not start a fresh full floor interval after every timer wake.
      .map((time) => time > now ? time - now : 250);
    return due.length
      ? Math.min(connection.pollIntervalMs, ...due)
      : connection.pollIntervalMs;
  }

  scheduleConnection(connection, delay = connection.pollIntervalMs) {
    const existing = this.timers.get(connection.connectionId);
    if (existing) clearTimeout(existing);
    // An exact-session Forbidden is terminal; do not run another timer
    // just to rediscover that no further provider call is allowed.
    if (!this.started || this.terminalConnections.has(connection)) {
      this.timers.delete(connection.connectionId);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        await this.pollConnection(
          connection.connectionId,
          { respectSchedule: true },
        );
      } catch (error) {
        this.lastErrors.set(connection.connectionId, safeMcpFailure(error));
        await this.observability?.emit({
          event: 'ei.source.poll_failed',
          level: 'warn',
          scopeId: connection.scopeId,
          connectionId: connection.connectionId,
          serverId: connection.serverId,
          error: new Error(safeMcpFailure(error)),
        });
      } finally {
        if (
          this.started &&
          this.connections.get(connection.connectionId) === connection
        ) {
          this.scheduleConnection(
            connection,
            await this.nextDelay(connection),
          );
        }
      }
    }, Math.max(0, delay));
    timer.unref?.();
    this.timers.set(connection.connectionId, timer);
  }

  start() {
    this.assertOpen();
    this.started = true;
    for (const connection of this.connections.values()) {
      this.scheduleConnection(connection, 0);
    }
  }

  async stop({ shutdown = false } = {}) {
    this.started = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    // Begin every host-owned teardown promptly. During final close a
    // provider hook may return/await the host.close() promise itself; an
    // unbounded await would deadlock the shutdown that the hook is waiting
    // for. Revoke callbacks before invoking hooks and use bounded best-
    // effort teardown during final shutdown only.
    const teardown = Promise.allSettled(
      [...this.deliverySessions.keys()].map(id => this.closeSession(id)),
    );
    if (!shutdown) {
      await teardown;
      return;
    }
    let timeout;
    try {
      await Promise.race([
        teardown,
        new Promise(resolve => {
          timeout = setTimeout(resolve, 500);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  async drain() {
    while (this.pollInFlight.size > 0) {
      await Promise.allSettled([...this.pollInFlight.values()]);
    }
  }

  close() {
    if (this.closePromise) return this.closePromise;
    // Close the authority boundary synchronously, including callers who
    // retain host.runtime.mcpEventsClient directly across host shutdown.
    this.closed = true;
    for (const listener of this.shutdownListeners) listener();
    this.shutdownListeners.clear();
    // Publish the manager close promise BEFORE any provider session hooks
    // can synchronously call host.close() and reenter manager.close().
    let resolveClose;
    let rejectClose;
    this.closePromise = new Promise((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    Promise.resolve().then(async () => {
      let closeFailure = null;
      try { await this.stop({ shutdown: true }); }
      catch { closeFailure = new Error('MCP shutdown session teardown failed'); }
      // Already-accepted manual/scoped attachments may be awaiting an
      // untrusted provider. All must settle (or fail on assertOpen) while
      // the runtime/store is still available, never after it has closed.
      while (this.attachInFlight.size > 0) {
        await Promise.allSettled([...this.attachInFlight]);
      }
      // A manually accepted detach can still be writing disabled source
      // records; release the authoritative store only after it settles.
      while (this.detachInFlight.size > 0) {
        await Promise.allSettled([...this.detachInFlight]);
      }
      // Attach registration must finish BEFORE last shared-authority revoke.
      // Otherwise a pending scope resolver could activate an epoch after
      // shutdown's premature revoke and leave other workers authorized.
      for(const connection of [...this.connections.values()]) {
        this.queueAuthorityRevocation(connection);
      }
      try { await this.flushAuthorityRevocations(); }
      catch (error) { closeFailure ??= error; }
      // Gaps acknowledged before the close fence can still have a
      // pending authoritative store write; finish them before runtime.close.
      while (this.reconciliationInFlight.size > 0) {
        await Promise.allSettled([...this.reconciliationInFlight]);
      }
      await this.drain();
      while (this.deliveryCallbackInFlight.size > 0) {
        await Promise.allSettled([...this.deliveryCallbackInFlight]);
      }
      // Detached, already-admitted appends still drain before store closure.
      while (this.occurrenceInFlight.size > 0) {
        await Promise.allSettled([...this.occurrenceInFlight]);
      }
      if (closeFailure) throw closeFailure;
    }).then(resolveClose, error => {
      // Keep all failed keys for a repeat close() after transient recovery.
      // A rejected cached closePromise must not permanently poison cleanup.
      this.closePromise = null;
      rejectClose(error);
    });
    return this.closePromise;
  }

  async status() {
    return Promise.all([...this.connections.values()].map(async (connection) => {
      const context = this.scopeContexts.get(
        `${connection.connectionId}::${connection.scopeId}`,
      );
      const store = context?.store ?? this.store;
      const states = await store.listMcpClientStates(connection.connectionId);
      const desired = context
        ? await this.desiredSubscriptions(connection, context)
        : new Map();
      return {
        connectionId: connection.connectionId,
        scopeId: connection.scopeId,
        serverId: connection.serverId,
        hostManaged: true,
        extensionId:
          this.profiles.get(connection.connectionId)?.extensionId ??
          MCP_EVENTS_EXTENSION_ID,
        compatibilityProfile:
          this.profiles.get(connection.connectionId)?.id ??
          connection.compatibilityProfile,
        events: (this.descriptors.get(connection.connectionId) || []).map(
          (event) => ({
            name: event.name,
            delivery: event.delivery,
            subscriptions: states
              .filter((state) => state.eventName === event.name)
              .map((state) => ({
                subscriptionId: state.subscriptionId,
                arguments: state.arguments ?? {},
                consumerCount:
                  desired.get(state.subscriptionId)?.consumerRefs.length ?? 0,
                delivery: state.deliveryMode,
                cursor: state.cursor,
                nextPollAt: state.nextPollAt ?? null,
                truncated: state.truncated ?? false,
              })),
          }),
        ),
        error: this.lastErrors.get(connection.connectionId) ?? null,
      };
    }));
  }
}
