# Host Adapter integration cost and multi-tenant design baseline

**Scope:** #352, parent #269. This is the **source-verified initial integration
audit**, not a new Host Adapter Kit API, a production-ready migration guide,
a measured engineering-hours benchmark, or independently authored
enterprise-host validation.

## What the current host API already provides

Public `mcp-event-intelligence/embedded` exposes the existing canonical
`createEventIntelligence({mcp,runtime,store?,hostContract?,...})`.
It composes the host's MCP Events registry and wake dispatcher without
loading another model or implementing a new agent runner. The same
embedded module already exports the EventSource registry, portable tool
catalog, `bindEmbeddedRuntimeIntegration`, typed operation metadata,
opaque `{runtime,kind,id}` continuation targets, scoped host access,
deterministic receipt ID and optional headless/no-agent-tools mode.

The host remains responsible for:

1. **MCP:** existing sessions/OAuth, event capability discovery,
   transport/connection lifetimes, provider quotas, session-epoch rotation.
2. **Principal/scope:** currently authenticated actor, durable owner, company
   and workspace isolation, team membership and membership revocation.
3. **Agent routing:** map opaque continuation to the actual graph, agent,
   user-visible workflow, checkpoint, Case or background job; do not force
   EI to understand the host's graph topology.
4. **Effect + idempotency:** durable **atomic** host-side outbox/receipt and
   enqueue, final authority check before the effect, reconciliation after
   process death/post-commit/pre-ack. A prior `hasReceipt()` check alone is
   NOT an atomic deduplication guarantee.
5. **Tools/policy:** `runtime.resolveContext()`, `runtime.control()`, and
   optional result/error projection. Tool catalog exposure does not authorize
   per-user writes. Native approvals, denials and interrupts remain host-owned.
6. **Deployment:** PostgreSQL pool/store lifecycle, shared-work fencing,
   backpressure, connection/tenant quotas, backups and operator signoff.

Sources (as checked in): `scripts/embedded-host-kit.mjs`,
`scripts/host-integration.mjs`, `scripts/lib/store-capabilities.mjs`,
`docs/STORAGE.md`, `docs/SECURITY-MODEL.md`.

## Orthogonal topology — NOT one scope per agent

The host should model these identifiers independently:

| Host identity / role | Recommended mapping | Ownership |
| --- | --- | --- |
| Company / organization | Explicit trusted organization identity, often part of EI `scopeId` | Authenticated host |
| Workspace / project | Separate EI `scopeId` if genuinely isolated; otherwise explicit access-controlled shared company scope | Host policy |
| Team | Host ACL and membership; separate EI scope where team-level data needs hard isolation | Host policy |
| User | `actor` (active principal), not interchangeable with durable trigger `owner` | Host authentication |
| Trigger owner | Stable host-attested principal / owner identity, including tenant identity | Host policy |
| Agent / workflow / checkpoint | Opaque `{runtime,kind,id}` continuation target | Host orchestrator |
| Worker / process | Independent consumer of shared PG state with a stable worker identity | Host deployment |
| MCP connection | Already-open authorized source, with scope and strict session authority epoch | Host MCP client |

A single workspace may use multiple agents and hundreds of users without
creating a separate EI process or persistence store for each agent.
Similarly, many teams can share an EI process while using different isolated
scopes and explicit host ACL. **EI scope separation is not a team RBAC
service.** Never accept tenant/scope, owner or target authorization from
untrusted MCP `event.data`, model output or a self-declared input.

There is **no implicit cross-company trigger join**. A business case
requiring data from multiple companies needs an independently authorized
host-controlled aggregation boundary or separately consented derived
events. Do not grant arbitrary cross-tenant scope access to EI.

### Three reference implementation profiles

| Profile | Initial wiring | The true costly part | Production risk |
| --- | --- | --- | --- |
| Headless background jobs | Registry + `runtime.deliver`, no model-facing tool bindings, optional single-process JSONL during local development | Stable durable job receipt/outbox and source reliability | Source/retry semantics |
| Multi-agent graph/worker runtime | Above, plus target resolution, graph/checkpoint load, correct agent routing, per-target receipts, PG shared state | Concurrency, resume/restart consistency and target revocation | Double resume, stale graph, lost receipt |
| Multi-company/team/user SaaS | Above, plus authenticated scope/owner context, team ACL, scoped event sources, PG, multiworker authority epochs | Cross-tenant isolation, membership revocation, quotas, audit and operational recovery | Cross-company visibility or unauthorized delayed effects |

A more complex runtime does **not** necessarily pay one EI integration per
agent. The adapter usually lives once at the runtime/host boundary. But
each new *authority domain* or independent recovery domain creates
additional tests and operational responsibility.

## Engineering effort estimates — NOT observed developer time

These are deliberately provisional ranges for a competent developer with
existing Node/TypeScript application/auth/workflow infrastructure. They
are **not** data from an external user study, not guarantees, and do not
include rewriting a host or creating missing event providers.

| Integration type | Developer effort estimate |
| --- | --- |
| Headless single-process proof of concept, already Events-capable MCP source | 0.5–2 engineer-days |
| Tool-enabled single-agent with real policy and persistent receipts | 2–5 days |
| Multi-agent graph with durable worker/replay and host idempotency | 5–10 days |
| Multi-user/team/company application on shared PostgreSQL | 2–4 weeks |
| Production multi-organization HA + external security/operator signoff | 4–8+ weeks, depending on existing platform maturity |

**If the source does not implement the experimental MCP Events profile**,
budget additional provider adapter/webhook/poll ingestion design, replay,
gap handling and credentials. That can dominate the initial EI SDK wiring.
EI does not make an MCP server automatically an Events-capable source.

Runtime direct infrastructure spend is driven mainly by worker/container
CPU, source poll/transport load, PostgreSQL storage/write volume, retry/
replay and log/archive retention. EI itself does not require an always-on
LLM loop; optional semantic predicates can incur *separate* model/provider
token charges. A numeric monthly cloud bill cannot be derived from code
alone without event rate, tenant count, trigger cardinality, wake volume,
availability target and hosting provider invoices.

## Currently measured host adapter cost (not a benchmark of dev time)

The source-pinned Muffin adapter comparison in
`docs/HOST-ERGONOMICS-CLOSEOUT.md` / `docs/HOST-TOOL-PRESENTATION-DECISION.md`
counts the *whole adapter*, not just a convenience wrapper:

| Case | Full adapter physical LOC | Nonblank LOC |
| --- | ---: | ---: |
| Earlier pinned 0.11 integration | 398 | 365 |
| Candidate canonical adapter | 391 | 360 |
| Saving | **7** | **5** |

This is ~**1.8%** physical LOC savings, **not** a credible productivity or
integration-cost breakthrough. 391 LOC is *not* EI core size or a
universal minimum: it includes Muffin-specific authority/Turn/taint/tool
glue. A rejected generic portable bridge (#270) would only have moved
code into another library without proven net benefit.

## Tests and measurements required before any new kit helper

The new #352 matrix must add nontrivial evidence beyond the existing
three EI-maintained v3 host reference shapes:

- **Headless:** no `runtime.resolveContext/control` requirement when no
  tools; no implicit unauthenticated mutation.
- **Multi-agent:** two different continuation kinds and agent identities,
  graph checkpoint resolution, explicit host-owned atomic outbox receipt,
  crash post-commit/pre-ack and replay with no duplicate host effect.
- **Two companies × two teams × two users:** two isolated workspaces,
  a shared authorized user/team use case, denied cross-team inspection,
  denied foreign target and no actor=owner conflation.
- **Revocation races:** user removed from a team after a trigger matched
  but before wake; provider session revoked/rotated; no delivery to a
  now-unauthorized agent or stale connection. A persisted EI wake is not
  permission to perform its associated host effect.
- **Distributed:** two independent PostgreSQL16 worker pools and
  source/receipt reconciliation across restarts. Strict multiworker mode
  requires `requireMcpSessionFence:true`, unique authority epochs and
  no mixed fenced/unfenced workers. Single-process JSONL is not HA.
- **Optional tooling:** static capability allowlist, native execution
  `control()`, preserved deny/interrupt, tainted result/evidence and
  outbound size limits; no generic renderer that escalates trust.
- **ROI:** separately source-pin full host app before/after, all new
  shared kit/fixture production LOC, new dependencies/package weight,
  human steps/time (when actually observed), and direct adapter overhead.
  A test host maintained by EI must be labeled EI-maintained.

## Decision gate

**No new generic adapter API yet.** First implement the two distinct
realistic reference hosts and measure where the *same* non-policy glue
recurs. If an optional typed composer reduces **combined app + library**
production code and installation steps without hiding authority or
introducing another runtime/SDK, propose it in its own reviewed PR.
Otherwise favor concrete host recipes, conformance test helpers and
onboarding documentation over an unnecessary `HostAdapterKit` wrapper.

Independent security/provider/HA signoff remains under #317/#47;
the tests above do not certify a stable v1 release or close #269.
