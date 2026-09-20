# Changelog

All notable public changes are documented here.

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
