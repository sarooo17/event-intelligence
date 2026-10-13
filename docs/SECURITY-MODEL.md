# Security Model

## Trust boundaries

Event Intelligence sits between event producers and agent runtimes. The main trust boundaries are:

1. provider / MCP event source → Event Intelligence;
2. user or agent → trigger control plane;
3. Event Intelligence → runtime callback;
4. persistent store / audit evidence.

## Ingress

Provider-specific ingress should authenticate at the provider boundary. The GitHub adapter verifies the webhook signature when configured.

For MCP Events ingress, the embedding host retains the MCP transport, authorization context and provider credentials. Event Intelligence enumerates the host-provided MCP registry and reuses only Events-capable client objects. It does not copy or persist provider OAuth tokens, API keys or connection URLs.

Event IDs are deduplicated before they can become a second logical source occurrence.

### Untrusted MCP event-source discovery bounds

A host-authorized MCP producer may still return a hostile `events/list`
catalogue. Before source registration, EI now requires a finite discovery with
at most `MAX_MCP_EVENT_DISCOVERY_PAGES=32` pages,
`MAX_MCP_EVENT_DISCOVERY_SOURCES=256` descriptors total per connection,
and opaque cursor values no longer than `MAX_MCP_EVENT_CURSOR_BYTES=4096`.
Repeated cursors (including longer cycles) fail closed with
`MCP_EVENTS_DISCOVERY_LIMIT_EXCEEDED`; malformed cursor types fail with
`MCP_EVENTS_DISCOVERY_CURSOR_INVALID`. Type and cycle checks run before
parsing the corresponding page, and page/descriptor limits run before any
new descriptor registration, so **pagination validation failures** do not
publish a partial new catalogue. This is **not a transactional publication
guarantee**: an independent error during a later `registerEventSource`
operation can still leave earlier descriptors persisted. The host remains
responsible for registration rollback strategy, network timeouts and maximum
RPC response bytes.

### Untrusted decoded discovery objects

After the page/count/cursor limits have been checked, EI snapshots every
bounded `events/list` descriptor array using the same JSON-safe, own-data
clone as occurrence ingress. Top-level `events` and `nextCursor` values are
obtained through own property descriptors, **not** JavaScript property getters.
Proxy wrappers and accessor-backed top-level fields fail with
`MCP_EVENTS_DISCOVERY_PAGE_INVALID`; hostile nested schema values, sparse
arrays, accessor descriptors, Proxies, cycles or non-JSON values fail with
`EVENT_UNTRUSTED_DATA_INVALID` before source registration. The clone
ignores non-enumerable custom iterators and prevents later provider mutation
from altering a schema while registration awaits storage. Only the bounded own
indexed array slots are staged; arbitrary extra enumerable array keys are
ignored rather than enumerated into the deep snapshot. This prevents a short
event array with very large unrelated metadata from exhausting descriptor
reflection budgets. Likewise, only the six top-level descriptor
fields actually consumed by source normalization are read through own data
descriptors; irrelevant producer-added keys are never enumerated. Nested
advertised payload/input schemas and descriptor metadata are semantically
consumed and can themselves be large, so host-enforced transport response
byte/time limits remain mandatory. The shared JSON snapshot itself now
inspects only own indexed array slots (without enumerating arbitrary extra
array properties), protecting nested `delivery` arrays and other nested JSON
arrays against metadata amplification.

The previous cursor type, cursor-byte/cycle, page-count and descriptor-count
checks keep their ordering and error codes. These checks protect **decoded
JavaScript objects**, not the host's raw MCP transport body size, timeout or
provider authentication. A host adapter returning a JavaScript Proxy through
an async function can invoke its `then` getter during ECMAScript Promise
assimilation **before** EI receives the value; hosts must decode untrusted
wire responses into plain JSON values at that transport boundary.
Partial persistence after a later independent storage error remains possible
as described above.

**Scope:** These are finite `events/list` pagination limits, not a
full per-tenant ingestion rate/size/regex complexity policy. Existing source
records are not removed automatically when a subsequent discovery fails;
the host must act on producer connection revocation. Other ingress and
backpressure acceptance items remain open in #45.

### Untrusted MCP poll page count bound

Each host-owned connection configures `maxEvents` between **1 and 500**
(default 100), and `maxPollBatches` between 1 and 32. The manager sends
`maxEvents` to the producer in each `events/poll` request **and rejects any
response whose `events.length` exceeds that count** with
`MCP_EVENTS_POLL_BATCH_LIMIT_EXCEEDED`. Rejection happens before appending
any event from that page, evaluating CEP, advancing a cursor or storing the
producer's replacement cursor. A legitimate retry starts at the old cursor.
The error carries no event payload, subscription arguments or event IDs.
Before the first asynchronous append, EI snapshots the bounded page using
own-data array slots and JSON-safe event copies; custom iterators, sparse
entries, accessors and proxies cannot inject more records or mutate later
queued events. Unsafe values are rejected before any append/cursor write.
Exactly sized pages remain valid; the total across multiple valid pages may
exceed the per-page limit, up to `maxPollBatches`.

**Limitations:** this bounds a single decoded poll response's event count,
not transport body bytes, JSON nesting, callback-stream rate, total
tenant-level ingress bandwidth, or the known cross-worker transaction gap
during connection revocation. The host must separately enforce transport
response-byte/time budgets and provider authorization.

### Push and webhook callback JSON boundary

Push/webhook adapters are host-owned transports, but their event and cursor
callback values are **untrusted input**. Before parsing, appending or awaiting
storage, the embedded manager takes a synchronous bounded own-data JSON
snapshot of each incoming event (including any optional cursor). The same
non-executing descriptor snapshot protects `onActive` and `onGap` callback
cursor updates before persistence. Top-level and nested Proxies, getters,
cycles, sparse arrays and oversized decoded object graphs fail closed with
`EVENT_UNTRUSTED_DATA_INVALID`; a caller mutating its original object while
a write is in flight cannot change the accepted event or persisted cursor.

This covers decoded callback-object integrity, **not** raw network-body byte
limits, payload-byte limits, per-tenant rate/burst limits, cross-worker atomic
source revocation, already queued wake cancellation, or adapter handle
properties. Host-level transport and authorization controls remain required.

## Trigger authority

A trigger may only reference active event sources available in its scoped connection set.

Agent-authored persistent mutations require a confirmation identifier. For common cases, the surrounding agent can submit an agent-friendly plan to `trigger_plan` / `planTrigger()`; Event Intelligence deterministically resolves live sources, validates advertised fields, and compiles the canonical trigger definition before persistence. Advanced callers may still submit canonical definitions directly.

Planning does not grant authority. Source scope and advertised predicate, Pattern, partition and projection paths fail closed when the source provides a payload schema. The embedding host remains responsible for deciding which user/agent may create or mutate triggers.

## MCP connection revocation and in-flight delivery

A host-managed MCP session may be removed while an Events poll is in flight,
a push/webhook callback has been queued, or a replacement MCP client is
attached under the **same** connection ID. The connection ID by itself is
not sufficient authority to ingest new events.

`McpEventsClientManager.detachConnection()` now removes the active connection
object **before the first awaited cleanup step**. Poll ingestion, callback
handling, cursor persistence, discovery and stream subscription setup must
recheck that their **exact connection object** is still attached. An old
callback cannot gain authorization by reusing a new session's connection ID.

- A poll response that arrives after the detach is rejected with
  `MCP_EVENTS_CONNECTION_DETACHED` before its events are processed.
- Late push/webhook `onEvent`, cursor, error and termination callbacks are
  ignored. A stream that completes opening after detach is closed without
  being installed.
- Source registration, cursor read-modify-write and detach deactivation
  share a per-connection asynchronous mutation queue. This fences already
  started writes in a deterministic order: old writes complete, detach's
  disable runs, and only then can the replacement publish its descriptors
  or cursor. A revoked operation that has not entered the queue fails closed.
- Stream cleanup references the exact connection/session object, not the
  reused ID. Late state initialization cannot re-register a revoked stream,
  and a retiring session cannot close the replacement's live handle.
- The host must explicitly reattach/re-authorize a new MCP connection; no
  private tokens are retained by EI.

**Race boundary:** The mutation queue is **process-local**, not a
distributed lock, and serializes source/cursor state **only through this
manager instance**. It does not make external host writes atomically
revocation-aware. A store append that started before revocation may commit
while detach is in progress. EI checks the session again after the append and
does **not** pass that occurrence to the CEP consumer if authorization was
revoked. However, without a shared transactional connection-epoch fence an
accepted occurrence record can remain in durable storage; on subsequent
re-authorization its deduplication ID may suppress the same event. Treat
this as a fail-closed, at-least-once boundary with possible replay gaps—not
an exactly-once guarantee or complete provider-level revocation protocol.
Previously queued and matched events may still require host-owned
cancellation policy before waking an agent. Stronger atomic cursor/append
fencing and explicit queued-work revocation belong to #45.

### Untrusted MCP provider failures are not diagnostics authority

An authenticated host-owned MCP producer can fail with arbitrary exception
messages, push/webhook callback errors or stream termination details. These
values may contain private event payloads and **unlabelled** secrets that no
regex-based redaction could identify. They are not trusted just because the
embedding host supplied the transport.

EI's manager now returns a fixed safe failure description instead of echoing
an untrusted provider exception in discovery results, `pollAll()`, connection
`status().error`, push/webhook callback status or operational telemetry.
An MCP provider request failure throws a neutral EI error code
`MCP_EVENTS_PROVIDER_REQUEST_FAILED`; the registry attach path reports
`EI_HOST_REGISTRY_ATTACH_FAILED` without copying the provider's error.
Capability-unavailable remains an explicit non-Events discovery status.
Untrusted termination objects are not serialized, and failures do not change
trigger matching or wake retry policy. This is a **pre-v1 diagnostics
behavior change**: hosts that need private transport-level debug messages
must log them in their own separately permissioned sink, never forward raw
messages into EI status, model-visible tools or shared telemetry.

This does **not** sanitize arbitrary provider-controlled event names or
host-selected connection IDs used elsewhere, protect network transport logs
before EI receives a response, establish quotas or revoke already queued
wake work. The host still owns transport credential management, network
timeouts, private debug retention and notification authorization.

## Telemetry redaction at the observability boundary

The `ei.*` best-effort observability emitter uses an allowlisted record
shape, drops sensitive metadata keys and redacts bearer credentials and
key/value tokens in **all accepted string dimensions**, nested metadata and
serialized error messages. These filters run before handing the record to
host-provided telemetry sinks. A deterministic synthetic 64-case mutation
corpus exercises metadata, errors and top-level dimensions.

**Limitations:** Pattern-based redaction is defense in depth, not a guarantee
that all possible arbitrary secrets can be recognized in unlabelled text.
The producer/host **must not submit private event payloads, tokens or
continuation instructions as telemetry dimensions**. A sink may store any
record it receives; host retention and data-transfer policies remain
host-owned. Disabling the emitter or sink failure does not change EI event
matching or wake delivery.

## Standalone MCP read authority

The standalone stdio server is configured with a trusted `MCP_OWNER_ID` and optional
`MCP_TENANT_ID`. Model-supplied inputs **cannot** override these identities.

- `trigger_list` always uses the configured owner and has no `ownerOnly:false` bypass.
- `trigger_inspect` first checks an owner-scoped trigger entry for the requested
  ID/version and refuses foreign IDs with the same generic not-found error. When a version is omitted, it explicitly chooses the latest **owned** version and pins that version for the subsequent inspector lookup, so another owner's newer version cannot be selected.
- `wake_hydrate` requires a trigger-scoped wake whose subscription ID,
  matched event ID, trigger identity/version and optional persisted delivery
  row are consistent. It checks trigger ownership **before** retrieving matched
  evidence, then delegates to the existing provenance-aware hydrator.
- Read guard refusals return `EVENT_INTELLIGENCE_RESOURCE_NOT_FOUND` without
  confirming whether the foreign identifier exists.

These restrictions apply to the bundled standalone MCP session, **not** a new
authorization service for embedded hosts. In embedded mode, host-owned scoped
context and policy checks remain mandatory. The stdio server is intended for a
single configured owner; it must not be exposed as an unauthenticated multi-user
remote endpoint. Global event-source/derived-contract discovery and aggregate
runtime status remain operator-context surfaces, not per-user scoped projections.
The remaining cross-tenant audit and session-rebind work is tracked in #45.

## Derived events

Derived event payloads are not arbitrary copies of parent payloads.

Only explicitly configured scalar projections and constants enter the new event. Lineage stores refs/hashes instead of raw parent payloads.

Contract fingerprints prevent same-version producers from silently changing the derived-event shape.

## Runtime wake

In embedded mode, the harness normally supplies one in-process wake dispatcher and routes by the validated trigger target; runtime-specific handlers are an optional lower-level path. Trigger authors cannot create arbitrary handlers or callback endpoints.

The wire wake remains reference-only. Embedded callbacks may additionally receive a hydrated Activation Envelope containing the persisted continuation plus matched evidence. The envelope labels the continuation as configured trigger instruction and event evidence as untrusted external signal data. Hosts must not treat event payload contents as instructions or as new authorization.

Standalone deployments may use operator-configured remote callbacks. Those targets must use HTTPS (except local development) and shared secrets must meet the implementation's minimum length.

Remote wake requests are HMAC-signed over canonical packet content and a timestamp. Runtime receipts are persisted and stable wake IDs make replay idempotent in the validated scenarios.

### Hydration provenance invariant

A stored wake, its persisted delivery row, and the selected trigger match **must describe the same activation**. Before rehydrating event evidence into a runtime continuation, EI checks that a trigger-scoped wake's source match ID agrees with the delivery's match ID, that the wake subscription identifies the same trigger as the selected match, and that the delivery's trigger ID/version agrees with the match. Inconsistent linked records fail closed with `ACTIVATION_PROVENANCE_MISMATCH`; the check happens before evidence is returned to the caller. A missing match also fails closed.

These invariants are defense in depth against corruption, stale cross-trigger references or faulty storage adapters. They do not authenticate a caller: the embedding host must still enforce authorization and return a tenant-scoped store. They do not make externally supplied event payloads trustworthy.

## Persistence and audit

The JSONL store is single-writer reference infrastructure.

The audit stream is hash-linked. This makes local tampering detectable when verification is run, but the same process controls the files; therefore it is not an immutable audit system.

The bundled store physically partitions non-default scopes and serializes writes within one process. The trusted root host can enumerate scopes; tenant-facing callers should receive only `host.scope(scopeId)`.

Production hardening should use:

- transactional storage / outbox for horizontally scaled deployments;
- atomic cross-process wake claim/lease operations in custom stores;
- external retained audit sink;
- secret manager;
- host-level tenant/user authorization in front of scoped capabilities;
- rate limiting at the deployment edge;
- backup / restore testing.

## AI boundary

Event Intelligence does not contain a general-purpose agent or natural-language model planner. The surrounding harness/agent performs natural-language reasoning. Event Intelligence can then deterministically compile an agent-friendly trigger plan into the canonical Pattern trigger.

The only bundled AI adapter is the optional TypeSafe Jev semantic evaluator, used only by an explicit Pattern `semantic` node. A model cannot gain authority by inventing an event source, field, runtime target or contract version because the deterministic control plane validates the submitted program against scoped live sources and schemas.

## Untrusted JSON property resolution

Event-clause predicates, Pattern v2 arithmetic selectors, partition keys,
semantic input projection and derived-event field selection all share
`readOwnEventPath()`. It reads only **own data property descriptors**, never
prototype-chain properties or accessor getters. Inherited `constructor`,
`toString`, `__proto__` and custom prototype properties do not count
as evidence; explicitly owned JSON keys remain readable. This prevents
correlation or semantic decisions from relying on fabricated inherited
tenant attributes, without treating untrusted event data as authority.

The event ingress entry point now takes a bounded, descriptor-only snapshot
*before* the Zod parser can read nested records, hashes, or pattern handlers.
Proxy objects, accessor-bearing properties, circular structures, sparse
arrays and non-JSON values fail closed with `EVENT_UNTRUSTED_DATA_INVALID`; selected
object/array terminals are detached from inherited indexed properties.
No external event code or property getter may participate in matching.

Deterministic tests cover inherited and own JSON keys, getter non-execution,
malicious sparse arrays, pre-parser accessor rejection, semantic input
projection and real Pattern engine partition isolation.
The host must continue to enforce owner permissions on every wake.

This closes a specific event-evidence ambiguity under #45. Other trust-boundary
hypotheses, complete tenant fuzzing and independent security review remain open.

Both direct composite ingestion and MCP Events occurrence conversion
snapshot provider data before schema validation or canonical payload hashing.
MCP conversion also snapshots subscription arguments; tests verify zero
accessor or Proxy trap execution before hashing.

The JavaScript ingress explicitly rejects native `Proxy` values (including
nested and array proxies) via Node's `node:util/types.isProxy` before any
reflection or traversal can trigger attacker-defined proxy traps. This is a
Node-specific security boundary; other JS runtimes need their own equivalent
intrinsic or a wire-JSON-only ingress contract. The event payload remains
untrusted even after normalization.
