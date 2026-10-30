# #269: real non-Muffin tool surface + measured multi-tenant reference scale

This is a **source-pinned bounded integration investigation**. It does not
certify a new Host Adapter Kit abstraction, independently authored adoption,
production tenant SLO or HA. No user-owned consumer is auto-merged here.

## R3 — an existing real application tool surface, not a second EI-maintained fixture

The previous [cross-consumer audit](HOST-ADAPTER-CROSS-CONSUMER-AUDIT.md)
accurately describes the **102-line Artemis EI lifecycle as headless**:
it does not call `ei.bind` nor expose EI's own portable eight-tool catalog.
However, describing the **entire Artemis application as headless** is
inaccurate. Artemis already has its **own native agent-facing tool surface**,
with a tenant-scoped control plane using the SAME EI host:

- [Artemis Demo candidate #124](https://github.com/sarooo17/artemis-demo/pull/124)
  HEAD `61cdc688db001548000c8891855b8b6b78f4f173`, source
  `backend/src/host/event-intelligence/artemisEventIntelligenceHost.js`,
  Git blob `caf53d9f1f336e78658f6f2849c700788153c3b6`, 102 physical /
  91 nonblank. Calls public `createEventIntelligence({mcp,runtime})`,
  deliberately **zero `ei.bind` model-facing portable tools**.
- Application control module
  `backend/src/capabilities/control/eventTriggerControl.js`, blob
  `373f2d6d0cbed4302441c035023b8ed616ea2d3c`, **874 physical /
  796 nonblank**. Native `createEventTrigger` resolves live host
  `tenantId,userId,chatId` from trusted request context, obtains
  `lifecycle.host.scope(tenantId)`, checks explicit user intent,
  plans with `scoped.planTrigger`, and creates with
  `scoped.triggerControl.createTrigger` using host-owned user/agent
  identities and `confirmationId`. This module handles business-facing
  descriptions, predicates, subscriptions and lifecycle beyond EI glue.
- Native front-desk tool catalog
  `backend/src/capabilities/port/createFrontDeskControlTools.js`, blob
  `839349175add04a32bd13c5c31a6049d0fb7c3a0`, **406 physical /
  397 nonblank**. Its actual agent tool specs include
  `event.trigger.sources/language/list/inspect/create/delete`, and
  its executor routes through host capability handlers rather than through
  a fake standalone conformance SDK. These are part of a larger mixed-use
  front-desk tool module; **not 406 lines of EI integration**.
- Native control handlers
  `backend/src/capabilities/control/handlers.js`, blob
  `b6bae650b8edb072caa890b9f88ed8f3dff952be`, 606 physical /
  576 nonblank. Includes other application capabilities; **not** purely
  EI cost. Existing
  `backend/src/capabilities/control/eventTriggerControl.test.js`
  blob `fab1f9ef146a805c009fd04c129e6b383aff4ecd` tests its
  tenant-scoped native control paths.
- Artemis #124's candidate EI public npm canary and app CI green at
  referenced HEAD; independent Codex summary reports no findings and no
  unresolved threads on exact candidate SHA. **Merge was attempted and
  rejected by GitHub branch rules (two required status checks expected)**,
  so the candidate is **unmerged**, not a released production consumer.

Contrast the real [Muffin native-tool candidate #18](https://github.com/sarooo17/muffin-agent/pull/18):
`agent/event-intelligence.ts`, blob
`09aa488ac6463d365378be2bb49f89bd00e32140`,
372 physical / 346 nonblank. Muffin calls the same public EI facade
**and binds EI's portable eight-tool catalog**, but owns its own
policy, Turn queue, taint/fence and receipt semantics.

**Implication:** two different **real application tool-enabled surfaces**
exist; one translates the EI portable catalog into the host's native ABI,
the other exposes separate host-native business tools and directly operates
EI's scoped control plane. Both use the runtime-neutral embedded host
entry point. **Neither establishes identical eight-tool behavior or common
safe native glue across host tool ABIs**, and both repositories belong to
the same owner. This is NOT independent third-party maintainer adoption.
Their distinct owner/tenant, execution, request-confirmation and trust
machinery must stay outside EI. Comparing the 102-line Artemis lifecycle
to Muffin's 372-line full tool adapter as equivalent is invalid.
No new generic binder is warranted.

## R4 — actual fresh-process scheduler/RSS cold-start evidence

Reviewed, merged [PR #366](https://github.com/sarooo17/event-intelligence/pull/366):
HEAD `ebbf57bec55ef33a325b9ee97d76b143cb52537f`,
squash commit `e8b52ee202eaa1c2e236342d4b2774af17a7dc92`,
7/7 exact-HEAD workflow families green, independent Codex clean.
The [CI artifact](https://github.com/sarooo17/event-intelligence/actions/runs/41107929940)
`host-scope-coldstart` supplies source-pinned fresh Node OS-process JSON
for each reference tier.

| Persisted scope count | Cold start (ms) | Resident memory delta | Real timers | Replicates |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 5.656 | 131,072 bytes | 2 | 3 |
| 10 | 13.533 | 393,216 bytes | 20 | 3 |
| 100 | 73.665 | 4,194,304 bytes | 200 | 3 |
| 1,000 | 597.098 | 30,691,328 bytes | 2,000 | 1 |

These are reference **JSONL**, no MCP provider, no due wake/deadline,
no PostgreSQL network/worker queue, no tenant-level backpressure and no
production SLO. 1/10/100 use median of three fresh-process measurements;
1,000 is **one** sample. All timer handles were observed and verified
closed (zero leaked after shutdown). The implementation starts a temporal
scheduler plus a wake-retry scheduler **for every persisted scope**, not
only scopes currently active. Do not claim this workload scales for
1,000 *active* companies, or remove inactive scope timers lazily without
preserving overdue persistent wake/deadline replay semantics.

The previously [reviewed PG16 two-OS-process host test #361](https://github.com/sarooo17/event-intelligence/pull/361)
separately verifies host-owned atomic receipt/outbox, simultaneous
missing-receipt contention, live membership revocation, forged scope
denial and recovery after SIGKILL post-COMMIT/pre-ack with fresh worker.
The multi-org scoped-host test
`test/postgres-host-adapter-multiorg.test.mjs` exercises
two orgs, multiple teams/users, agent and graph target kinds with real
PG16 pools. **These do not measure 1,000-scope PostgreSQL production
load or external provider latency.** Do not infer operational cloud
costs or RTO/RPO from successful CI.

## #269 acceptance reconciliation

- R3: **real second unlike tool-enabled application demonstrated** at
  source/test level, but public canonical Artemis migration is **not merged**,
  and no unrelated third-party maintainer independently adopted/reviewed
  EI. Do not label it external validation.
- R4: **reference scale tiers and PG two-worker safety** demonstrated with
  separate evidence. Live 1,000-tenant PG/network SLO and provider-load
  behavior **unproven**; belongs to production #47/#317 if promoted as
  release acceptance.
- R1/R5: reviewed #364/#365 whole-adapter and registration-only same-host
  metrics, without independently measured onboarding time/cost.
- R6: current defensible decision remains **no new Host Adapter Kit API**.
  EI's existing `/embedded` exports are sufficient for the evaluated
  application shapes; there is no measured net ROI for another generic
  adapter layer. Close #269 only if its explicit external adoption and
  full acceptance requirements have evidence or a transparent product-owner
  scope decision—not by converting unmerged/staging tests into production.
