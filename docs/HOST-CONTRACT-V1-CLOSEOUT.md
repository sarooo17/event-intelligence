# HostContract v1 — issue #42 API, error and ownership audit

**Status: implementation audit, NOT external host acceptance.** Candidate at
`sarooo17/event-intelligence` main commit `6ff40250afc67c259e8b784a7eb9ec03d9184fa9`
(2026-10-18). This report is maintained as part of EI #42 and #50;
publishing v1.0 and downstream pin upgrades remain separate operations.

## Public contract inventory

| Surface | Intended role | Status and evidence |
| --- | --- | --- |
| `mcp-event-intelligence/embedded` `createEventIntelligence()` | Canonical high-level integration and explicit optional HostContract v1 | Implemented; `test/embedded-host-contract-v1.test.mjs`, `test/host-v1-api-contract-audit.test.mjs`, fork conformance |
| `createEmbeddedRuntimeIntegration()` | Advanced low-level composition (explicit host wiring) | Retained for distinct advanced behavior, not old-vendor compatibility |
| `/conformance` `runHostConformance({profile:'management'})` | Public v3 contract, 7 scenarios | All 7 passed on Muffin fork using **canonical v1** and in three EI-authored shapes |
| `/host` | Advanced host runtime integration, source lifecycle and durable store | Retained as separately useful low-level operation |
| `/embedded` `.d.mts` and `/host` `.d.mts` | TypeScript consumability | Public targets checked and used by packed tarball CI |
| Obsolete `authorize()` fallback | Old shortcut bypassing `runtime.control()` | Removed under #109, no compatibility shim |
| Vendor dispatch `toMuffin()`/`toOpenAI()` or runtime-name switch | Forbidden | Source regression scan in `test/host-v1-api-contract-audit.test.mjs` |

The `hostContract` list is **opt-in before v1.0** and checks capability
*configuration*, not the correctness of external authorization or delivery.
Supported capability IDs: `mcp.registry`, `storage.durable`,
`storage.shared`, `wake.receipts`, `tooling.owner-scoped`,
`semantic.evaluate`, `observability.sink`. Each required missing
capability is rejected before host startup. No implicit permission grants.

## Stable configuration error matrix

The new regression matrix checks **pre-start** configuration rejections with
stable `EI_HOST_*` codes and proves that the injected host factory is **never
called** for those invalid setups. Other listed codes below are independently
covered by separate post-start/lifecycle tests; the matrix does **not** claim
to exercise every row. These are configuration or lifecycle boundaries, not
remote transport health guarantees:

| Code | Fail-closed condition |
| --- | --- |
| `EI_HOST_DELIVERY_REQUIRED` | No safe callable `runtime.deliver` |
| `EI_HOST_MCP_REGISTRY_INVALID` | Invalid supplied MCP registry callback shape |
| `EI_HOST_CONTROL_REQUIRED` | `resolveContext`/`control` not supplied together |
| `EI_HOST_RECEIPT_CONFIG_INVALID` | Incompatible receipt identity strategies |
| `EI_HOST_CONTRACT_INVALID` | Malformed/declaratively invalid HostContract |
| `EI_HOST_CONTRACT_VERSION_UNSUPPORTED` | Unknown HostContract version |
| `EI_HOST_CAPABILITY_UNKNOWN` | Unknown required capability name |
| `EI_HOST_CAPABILITY_UNAVAILABLE` | Missing mandatory registry, receipt, tooling or optional semantic/observability wiring |
| `EI_HOST_STORAGE_REQUIRED` | Required durable store not configured |
| `EI_HOST_SHARED_STORE_REQUIRED` | Shared store does not meet the distributed-store capability contract |
| `EI_HOST_CALLBACK_INVALID` | Invalid optional runtime callback |
| `EI_HOST_LIFECYCLE_INVALID` | Host startup returns no safe close surface — **post-creation validation**, not a preflight error |
| `EI_HOST_CLOSED` | Lifecycle/registry operation attempted after close fence — **post-start shutdown error**, not a preflight error |

The two lifecycle errors are validated in
`test/embedded-lifecycle-ownership.test.mjs` and
`test/host-registry-shutdown-contract.test.mjs`, **not** the new no-start
configuration matrix. An invalid `createHost()` result necessarily means the
factory was invoked, while `EI_HOST_CLOSED` requires an already-started host.

Source of truth for error behavior: `scripts/embedded-host-kit.mjs`,
`scripts/lib/embedded-host-contract.mjs`,
`test/embedded-host-contract-v1.test.mjs`,
`test/host-configuration-errors.test.mjs`,
`test/embedded-lifecycle-ownership.test.mjs`,
`test/host-registry-shutdown-contract.test.mjs`. This audit adds a
cross-cutting pre-start negative regression matrix and core vendor-dispatch
source check. It does **not** guarantee arbitrary host exceptions cannot
escape after startup.

## Reproducible host evidence

- EI-maintained local v3 matrix: `node conformance/host-v3-matrix.mjs`,
  `docs/HOST-V3-REFERENCE-MATRIX.md`. Three host shapes, all EI-authored;
  `independentExternalHostVerified: false`.
- Packed external Node filesystem: `docs/examples/packed-managed-consumer.mjs`
  with owner-controlled create/pause/resume/update/delete approval interrupt
  and persisted wake receipt; not a third-party authored host.
- **Muffin fork:** [PR #15](https://github.com/sarooo17/muffin-agent/pull/15),
  independent upstream runtime *code*, **EI-maintainer-authored adapter test**.
  Candidate tarball checked out and packed inside CI without touching upstream
  Muffin or publishing npm. Public conformance v3 uses canonical HostContract
  v1, Muffin-owned actor, owner, Turn receipt/wake and control callbacks.
  Process crash/recovery and five-action host approval coverage are tracked
  on that draft PR; count only green CI results on the exact final commit.
- Integration LOC accounting: separate the generic v1 configuration from
  runtime-specific Muffin identity, policy and Turn translation; do not claim
  Muffin's full adapter is <=30 LOC. Inspect fork PR's `agent/event-intelligence.ts`
  and `agent/event-intelligence-candidate.test.ts` changes for a definitive
  diff-based count at completion.

## Compatibility and decisions

1. No legacy adapter or `authorize()` fallback will be introduced merely to
   keep older Muffin or Artemis installs working. Advanced host primitives
   remain where they have independent capability.
2. Removing a previous import or changing conformance v2 to v3 is a pre-1.0
   breaking change documented in `CHANGELOG.md` / `docs/EI-RELEASE-COMPATIBILITY.md`.
3. Published `0.11.0` consumers remain pinned; merely publishing a new EI
   version does not modify another project. Shared-store schema compatibility
   remains a separate #50 concern.
4. No policy, OAuth, credentials, MCP network session, model tool exposure,
   continuation execution, Turn/Work idempotence or external notification moves
   into EI. EI owns event correlation/trigger state and its own logical wake
   delivery record. Exactly-once external effects are **not promised**.

## Closeout status of issue #42

**Implementation and internal test coverage:** substantially complete,
subject to final green exact-HEAD CI and reviewed fork additions. The
acceptance checkbox requiring *one genuinely independently written* host
adapter and its independent end-to-end confirmation **remains open**. This
document must never be used to silently check that box. Real MCP network
reconnect and distributed failover must be described as limits when only
synthetic registry/OS worker fixtures were run.

Separate v1 release gates, multi-worker PostgreSQL/SLO evidence and independent
security sign-off are tracked by their own issues; they do not close #42 by
implication.
