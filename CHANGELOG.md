# Changelog

All notable public changes are documented here.

## [0.2.1] - 2026-09-20

Patch hardening for shutdown determinism and multi-tenant verification.

### Fixed

- host shutdown now drains in-flight MCP polling, temporal/wake schedulers and persistent JSONL writes before returning;
- prevents background writes from racing temporary-directory cleanup and causing intermittent `ENOTEMPTY` failures;
- scoped isolation regression coverage now includes event source discovery, MCP client state/cursors, occurrences, audit records and wake visibility.

### Clarified

- the exported ERPNext helper is a typed MCP Events provider factory, not a credential-owning ERP connector;
- the production authenticated ERPNext implementation remains in `world-capability-mcp`, where real data access, tenant/company filtering, pagination, cursors and timezone handling are implemented.

## [0.2.0] - 2026-09-20

Production-hardening release for shared Event Intelligence hosts.

### Shared-host isolation

- explicit `scopeId` partitions for tenant/workspace isolation;
- scoped host views via `host.scope(scopeId)`;
- isolated triggers, matches, event sources, cursors, deadlines, derived events and wake delivery state;
- persistent scope restoration after restart;
- root host documented as a trusted operator/control-plane capability.

### Pluggable persistence

- `createEventIntelligenceHost({ store })` now accepts an external storage backend;
- `PersistentEventStore` remains the zero-dependency default;
- scoped custom backends can implement `forScope(scopeId)`;
- storage contract validates the operations required by Event Intelligence at startup.

### Durable wake delivery

- persisted wake-delivery state with `pending`, `claimed`, `retry_pending`, `delivered` and `dead_letter`;
- atomic claim/lease API for concurrent workers;
- bounded exponential retry and retry scheduler;
- restart recovery without a new provider event;
- reconciliation of a persisted runtime receipt after a crash without redelivering the wake;
- the direct `EventProcessor` path now uses the same durable retry semantics.

### Polling and load control

- single-flight polling per MCP connection;
- bounded `hasMore` page draining;
- cursor persistence after every drained page;
- explicit batch-limit reporting.

### Internal modularity

- composite store contracts extracted from `engine.ts`;
- matching/correlation helpers extracted into a dedicated module;
- derived-event cycle validation extracted into a graph module;
- lifecycle, deadline and audit support extracted from the engine.

### Provider coverage

- new `mcp-event-intelligence/provider/erpnext` export;
- provider-native ERPNext adapter for `erpnext.sales_invoice.submitted` and `erpnext.sales_order.created`;
- schema-validation and provider-generalization regression coverage.

### Verification

- tenant-isolation tests with identical trigger IDs in separate scopes;
- custom-store injection and restart persistence tests;
- polling single-flight and bounded-batching tests;
- retry, dead-letter, lease-contention and post-receipt crash-reconciliation tests;
- ERPNext provider adapter tests;
- CI, Security Scan, MCP Launch Check, Clean-room Smoke and Public Release Check green before release.

## [0.1.1] - 2026-09-20

Provider integration patch.

### Provider-facing MCP Events adapter

- public `mcp-event-intelligence/provider` package export;
- callback-backed `createMcpEventsProvider()` for stateless provider runtimes;
- generic experimental Events capability advertisement plus `server/discover`, `events/list`, and `events/poll` dispatch;
- provider-owned opaque cursors, authentication context, data queries and domain event semantics;
- fail-closed EventOccurrence and payload-schema validation;
- lower-level store-backed `ExperimentalMcpEventsServer` remains available through the provider export;
- packed-artifact smoke coverage for the new subpath.

The Event Intelligence and composite-trigger protocol/schema versions remain `0.1.0` / `v0.1`; this patch adds a package integration surface without changing persisted protocol contracts.

## [0.1.0] - 2026-09-20

Initial public reference release.

### Standard MCP control plane

- official TypeScript SDK v2 stdio server targeting MCP 2026-07-28;
- read-only Event Intelligence tools exposed by default;
- persistent mutation tools require explicit operator opt-in and confirmation IDs;
- `server.json` + npm `mcpName` ownership metadata;
- official MCP Registry schema/semantic validation in CI;
- packed npm artifact smoke-tested for MCP entrypoints.

### Launch visuals

- rendered hero architecture SVG;
- rendered durable-time/restart SVG;
- rendered Inspector/provenance SVG.

### Event ingestion and MCP Events boundary

- experimental MCP Events discovery, `events/list`, and `events/poll` compatibility;
- embedded host API discovers already-connected MCP clients from the harness registry;
- no duplicate provider URL/token configuration or per-MCP Event Intelligence setup;
- tools-only MCPs are ignored while Events-capable MCPs are attached automatically;
- dynamic registry refresh plus low-level attach/detach support;
- persistent opaque cursors and restart-safe event deduplication;
- GitHub provider webhook mapping into MCP EventOccurrence and automatic composite fan-in.

### Durable trigger engine

- `allOf`, `anyOf`, `sequence`, and `count`;
- deterministic same-value correlation;
- optional semantic correlation;
- persistent partial/matched/fired/expired state and replay safety;
- agent-authored trigger control with source scoping, advertised-field validation and approval gating;
- no bundled OpenAI planner: the surrounding agent authors the structured trigger directly.

### Temporal reasoning

- calendar-aware conditions with IANA timezones;
- `absence`, `not`, `unless`, `after`, `until`, `debounce`, `threshold`, `rate`, and `distinct`;
- durable deadlines that progress without a new provider event;
- restart recovery and DST-aware tests.

### Runtime continuations

- signed refs-only wake packets;
- one in-process harness wake dispatcher can route continuations to multiple agents;
- optional signed callback targets for standalone deployments;
- runtime receipts, retry/dead-letter lifecycle, and idempotency;
- trigger lifecycle policies: one-shot, max firings, cooldown, expiry, lease, update, delete, and self-retirement.

### Derived events and contracts

- trigger composition through immutable derived events;
- flattened root provenance and direct-parent lineage;
- cycle detection and recursion depth limits;
- versioned derived-event contracts with canonical schema fingerprints;
- compatibility preflight and ambiguous-consumer rejection.

### Observability and verification

- deterministic Trigger Inspector with why-fired / why-not-fired state;
- isolated trigger simulation;
- full-system black-box acceptance covering signed wake, contract evolution, replay, and restart during a pending deadline;
- real GitHub provider regression verified in the persistent environment.

### Known limitations

- MCP Events support targets an experimental design and is not a finalized MCP specification;
- automatic MCP discovery requires the embedding harness to expose its connected-client registry through the small host adapter interface;
- JSONL persistence is single-writer and reference-grade;
- no multi-replica / HA storage backend is included;
- the v0.1 MCP control plane is stdio-only; a Streamable HTTP control-plane transport is not included;
- Stateful Facts / current-state materialization is intentionally deferred.
