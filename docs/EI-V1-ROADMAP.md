# Event Intelligence v1.0 engineering roadmap

> **Status:** proposed, planning only. Baseline `mcp-event-intelligence@0.11.0` (2026-10). No claim that proposed features/tests already exist. Tracks [#41](https://github.com/sarooo17/event-intelligence/issues/41).

## Mission and positioning

EI is an **embedded, host-owned MCP Events intelligence layer** for persistent conditions, correlation, temporal matching, derived events and targeted agent continuation. The product opportunity is to make agents sleep between meaningful world changes. It is **not** a second agent harness, scheduler, credential store, provider integration platform or agent authorization engine.

External host adoption should require only a documented translation at the host boundary. The host retains MCP transports/OAuth, active connections, principal and tenant context, tool schema exposure, policy/approval/interrupt behavior, storage credentials, continuation identity, agent loop, result artifacts and final user delivery.

## What exists today (v0.11)

- Canonical `Pattern AST v2` for CEP; event-time semantics, watermark, late events, windows, negative deadlines, quantifiers, partitioning, aggregates and derived events.
- Optional bounded semantic nodes through `SemanticEvaluator`; deterministic evaluator remains the default.
- Host-registry auto-discovery of Events-capable clients, shared subscriptions, host-owned poll/push/webhook delivery, durable occurrence and cursor state.
- Embedded contract: `createEmbeddedRuntimeIntegration()`, `createEventSourceRegistry()`, host `activation` and `tooling`, portable tool catalog, `integration.bind()`, `integration.diagnostics()`.
- Owner-scoped embedded trigger management, machine-readable observability, host conformance core/management.
- Single-process JSONL reference store; optional Postgres authoritative cross-worker state, atomic wake claims and trigger/version/partition leases, replay/receipt recovery and scoped audit.

A production readiness score cannot be asserted from feature count. v0.11 CI validates selected deterministic multi-worker cases but **does not yet prove** industry-scale throughput or deep chaos/soak reliability. See [#21](https://github.com/sarooo17/event-intelligence/issues/21).

## Engineering principles (non-negotiable)

1. **Only one executable trigger language:** simple authoring APIs compile through the existing planner to canonical Pattern AST; never add parallel semantics.
2. **Only one authority path:** host must decide authorization, approval, interrupts, tenant context and mutation exposure. EI cannot infer or elevate authority from external events.
3. **Exactly-once is not assumed:** external delivery requires well-defined idempotent host receipts; document at-least-once transport and effectively-once logical outcomes only where proven.
4. **MCP clients stay host-owned:** no duplication of credentials, OAuth sessions, connection lifecycle or ordinary tool calls.
5. **No named runtime matrix:** never add `if(runtime === 'muffin')`, `toClaude()` or `toOpenAI()` in EI core.
6. **Storage is truthful:** JSONL is single-process only; Postgres/shared adapters must prove cross-worker safety.
7. **No silent regressions:** releases, persisted state, and downstream consumer upgrades require explicit compatibility decisions and CI evidence.
8. **Small independently reviewable PRs:** split unrelated refactors, semantic behavior changes, migrations and infrastructure.

## Phases and implementation issues

| Phase | Priority | Workstream | GitHub issue | Deliverable |
| --- | --- | --- | --- | --- |
| A | P0 | Embedded integration facade | [#42](https://github.com/sarooo17/event-intelligence/issues/42) | Minimal neutral host API; handshake; conformance v3 |
| A | P0 | Unified operation/capability registry | [#43](https://github.com/sarooo17/event-intelligence/issues/43) | Schema/metadata parity across embedded/MCP/CLI |
| A | P1 | Developer experience | [#46](https://github.com/sarooo17/event-intelligence/issues/46) | Typed simple triggers, doctor, simulation, docs |
| B | P0 | Formal CEP correctness | [#44](https://github.com/sarooo17/event-intelligence/issues/44) | Property/differential/adversarial testing |
| B | P0 | Security hardening | [#45](https://github.com/sarooo17/event-intelligence/issues/45) | Threat model, tenant/authority/payload tests |
| B–C | P0 | Shared storage/recovery/scale | [#47](https://github.com/sarooo17/event-intelligence/issues/47), [#21](https://github.com/sarooo17/event-intelligence/issues/21) | Migrations, retention, chaos, benchmarks |
| C | P1 | Explainability/observability | [#48](https://github.com/sarooo17/event-intelligence/issues/48) | Why-not-fired traces, optional OTel bridge |
| C | P2 | Semantic importance monitoring | [#49](https://github.com/sarooo17/event-intelligence/issues/49) | Bounded semantic triage and quality evidence |
| D | P0 | Compatibility and v1 release gates | [#50](https://github.com/sarooo17/event-intelligence/issues/50) | SemVer/data versioning, downstream safe upgrades |

Do not block a reliable v1 release on P2 semantic intelligence if its quality, privacy or cost criteria have not been demonstrated. Track it explicitly as subsequent evolution when necessary.

## Cross-area acceptance matrix (targets, not results)

| Dimension | Evidence for an externally credible top-tier implementation |
| --- | --- |
| Architecture | One canonical Pattern evaluator and capability registry; CI enforces ownership invariants; no code duplicated between named runtimes |
| CEP | Published semantics; differential/property model detects injected bugs; deterministic late-event/restart outcomes and explicit truncation handling |
| Runtime portability | At least 3 host-shaped integrations, including 1 genuinely independently written host; no EI core edits; core + management conformance pass |
| Persistence | Migration/restore/compaction evidence and multi-worker crash recovery with authoritative scope isolation and no unaccounted duplicate logical activations |
| Security | Threat model, adversarial cross-tenant and taint tests, secret redaction, independent review, no unresolved critical/high findings |
| Developer experience | Packed-artifact quickstart, doctor, simple typed API, virtual-time tests, newcomer clean-room usability observations |
| Observability | Why-fired/why-not-fired contract + causal traces, metrics, bounded memory/IO and verifiable non-leakage, telemetry nonblocking |
| Scale and operations | Reproducible 1k/10k/100k active-trigger workloads with p50/p95/p99, CPU/DB/memory/backlog, multi-worker soak, agreed SLOs and regression gates |

Do **not** infer a universal performance target: publish workload, number and composition of events, source poll schedule, hardware, Node, database, worker count and data cardinality. Any number without that context is not a readiness guarantee.

## Suggested PR sequence

1. Operation inventory + schema parity (no behavior change) [#43].
2. Additive high-level host façade + extended conformance [#42].
3. SDK ergonomics and optional doctor/sim fixtures [#46].
4. Formal CEP semantics and property/differential corpus [#44].
5. Trust boundary, source-revocation and security test suites [#45].
6. Store migrations, retention, crash/restore and soak [#47 / #21].
7. Explainability contracts and traces [#48].
8. Reproducible scale/SLO evidence [#47 / #21].
9. Independent consumer validation and release stabilization [#50].
10. Optional bounded semantic triage [#49] once budgets/quality prove useful.

Parallelize independent tests and docs, but **serialize changes to canonical schema, persistence layout and core pattern semantics**. Each PR needs a review-ready self-contained unit, CI, target/acceptance evidence and compatibility note.

## Release gates

- **Gate 0 — Baseline:** current main CI green; no unresolved high-priority regression.
- **Gate 1 — API:** packed-package smoke, semver/public surface checks and conformance for host/management/registry metadata.
- **Gate 2 — Correctness:** formal CEP suite, recorded seeds, deterministic time + restart, safe truncation.
- **Gate 3 — Trust and storage:** cross-tenant security, scoped access, persisted-state upgrade/restore, concurrent Postgres HA, fault injection.
- **Gate 4 — Performance:** archived scenario-based p95/p99/throughput/memory DB metrics plus regression budget; do not mark green on synthetic microbench alone.
- **Gate 5 — Consumers:** Muffin and Artemis candidate upgrade verified in separate opt-in branches; third-party host tested; no automatic dependency/deploy change.
- **Gate 6 — Release:** docs/security/changelog/version compatibility match published artifact; independent review sign-off.

Use [release compatibility policy](EI-RELEASE-COMPATIBILITY.md) and [embedded integration design](EI-INTEGRATION-V1-DESIGN.md) as the contract drafts to refine in implementation PRs.

## Ownership and issue closure

Every child issue must have: final code+commit/PR links, test commands, CI evidence/artifacts, measured limitations, affected public schemas, migration decision, downstream checks (where relevant), and independently reviewed acceptance criteria. Closing a task because documentation was added is not sufficient. Avoid closing [#21](https://github.com/sarooo17/event-intelligence/issues/21) until its remaining HA work is truly covered.

## Out-of-scope for this roadmap PR

This documentation-only PR creates **no runtime behavior**, **no new public API**, **no release**, **no passing conformance claim** and **no change to Muffin or Artemis**. Implementation must use separate focused PRs.
