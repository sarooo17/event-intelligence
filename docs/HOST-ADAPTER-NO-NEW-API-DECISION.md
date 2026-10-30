# Host Adapter Kit — no additional runtime API decision

**Decision scope:** #352 milestone E, parent #269. Evaluated 2026-10-30.
This is a source-audited composition decision, not a shipped SDK, a third-party
security audit, or proof of positive external integration ROI.

## Decision

**Keep `mcp-event-intelligence/embedded` as the single canonical
integration API.** Do not create a new `HostAdapterKit.createRuntime()`,
second dispatcher, universal `toTool()` converter, custom Principal/team
schema, agent loop, generic middleware authorization, or callback-forwarding
wrapper. The existing portable tool binder already covers static capability
allowlists and a two-phase adaptation stage (#270/#281).

The user-visible cost of an adapter is **host ownership**, not just the
initial EI facade: caller identity, team membership, scope, source session,
host-owned outbox, recovery and native result rendering. A smaller
source file that hides a host authorization check is a security regression.

## Cross-host overlap audit

| Boundary | Headless #355 | Multi-org agent/graph #356 | Muffin #282 | Existing EI |
| --- | --- | --- | --- | --- |
| Lifecycle/host API | `createEventIntelligence` | same | same | **provided** |
| MCP Events discovery | host registry | optional host registry | existing Muffin MCP registry | **provided** source port |
| Wake target | job | graph / agent checkpoint | Turn | **provided** opaque target and dispatcher |
| Stable receipt | job namespace | org/workspace namespace | host-managed receipt | **provided** deterministic receipt helper |
| Actual durable effect | host job queue | SQL row-locked team/member + outbox | native host resume | **host-specific** |
| Revocation | job resolver | membership table | runtime permissions | **host-specific** |
| Agent-facing tools | none | optional | native tools | **provided** portable catalog + result projections; host-specific native presentation |
| Store/multiworker | optional | host PG16 pools | host deployment | **provided** EI PG adapter; host owns deployment/session fencing |

**No duplicated provider-neutral implementation remains across both
reference hosts that is not already covered by the public facade.**
The substantial differences are not safe to extract: the organization
host must lock its CURRENT membership and commit a unique host receipt in
the same transaction; the headless host has job queue semantics; Muffin
has native Turn approval and result-taint semantics. An additive generic
wrapper would move those responsibilities rather than remove them.

## Source-pinned measurements and limitations

| Whole application adapter | Physical LOC | Nonblank |
| --- | ---: | ---: |
| Headless — `examples/host-adapter/headless-job-host.mjs` | 79 | 75 |
| Multi-org — `examples/host-adapter/multi-org-graph-host.mjs` | 184 | 179 |
| Two **different** app adapters | **263** | **254** |
| New generic EI Host Adapter Kit runtime LOC | **0** | **0** |

`scripts/validation/host-reference-integration-cost.mjs` verifies the
complete application-adapter Git blobs (headless
`eceb4c7db00bae0e14289496508f4644e130676b`, multi-org
`df02da9d2f269dd518bbe725ce2de01ac84f5b7d`). This is NOT an
application before/after comparison: subtracting 79 from 184 is meaningless.

The only source-pinned same-consumer before/after is Muffin: complete
adapter **398 → 391 physical LOC** and **365 → 360 nonblank LOC**, a
**1.8%** physical reduction. It is not a substantial productivity win.
The bounded PG16 host-query percentiles and npm pack footprint studied
in #358 also do not measure an independent developer's onboarding time,
old-vs-new application cloud bill, entire application diff or production
SLO. All fixtures are **maintained by EI**, not independently authored.

## Prefer existing APIs + concrete recipes

Use `examples/host-adapter/README.md` for headless queue systems and
`examples/host-adapter/MULTI-ORG-GRAPH.md` for multi-organization
agent/graph systems. The host supplies authenticated MCP connections,
live target/owner/tenant authorization, durable atomic outbox/receipt,
and optionally `runtime.resolveContext/control` plus native tool
registration. This does not require one EI instance per agent.

A policy-free convenience helper that accepts functions and forwards
them into the same existing facade offers at most cosmetic source
savings while increasing the library's public surface. For the measured
reference hosts, **no new generic API is justified**.

## Stop/go criteria for reconsideration

1. Two independently maintained, differently structured hosts show
   the same **safe neutral glue** that the current exported primitives
   cannot already express.
2. Compare complete host app source BEFORE and AFTER, count ALL new
   shared library runtime/typing/tests/exports/dependencies, check actual
   package footprint, setup actions, overhead and safety negatives.
3. Prove current team/tenant/owner authority at the effect boundary,
   durable cross-worker idempotency and wake post-commit retry,
   trust/taint, host-native interrupt/denial and exact capability
   allowlisting. EI must never infer host authorization from event data.
4. Require independent review on exact final PR head, green CI,
   PostgreSQL 16, clean-room public imports and no automatic consumer
   pin or npm-release changes.

**#352 milestone E:** explicit no-additional-API route; close this
milestone only after reviewed/green evidence. **#352 D remains open**
without full application comparison, independent human integration-time
data and demonstrated net benefit. **#269 stays open at 3/5**:
its portable bridge and ROI boxes are not silently reinterpreted as
implemented. #47/#317 production/security verification stays separate.
