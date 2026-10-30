# Runtime-neutral Host Adapter Kit: two real consumers, before/after, and API decision

**Evidence for:** #362, parent #269; related #352 (full-cost audit), #353 (tenant/process behavior), #41 (v1 scope). **Date:** 2026-10-30. This is a **source-pinned engineering audit**, not independently authored external validation, a production SLO, measured onboarding time, or a claim that #362 is closed.

## Why another generic adapter API is not yet justified

Compare full source files in **two real, differently shaped, user-owned application repositories**, rather than the EI-maintained reference fixtures alone:

| Consumer | Actual public EI integration | Host responsibilities outside EI |
| --- | --- | --- |
| [Muffin fork PR #17](https://github.com/sarooo17/muffin-agent/pull/17) + [refactor PR #18](https://github.com/sarooo17/muffin-agent/pull/18) | `createEventIntelligence({mcp,runtime,hostContract})`, `integration.bind({adapt,register,onClose})`; eight host-native model tools | Turn queue and session semantics, owner principal, permission/revocation and policy, taint/fence, native tool ABI, durable receipt/work identity |
| [Artemis Demo PR #124](https://github.com/sarooo17/artemis-demo/pull/124) | `createEventIntelligence({mcp,runtime})`, **headless with zero model-facing tools** | Per-tenant chat/user lookup and revocation, read-only request, wake receipt/claim in its own repository, MCP client lifecycle |
| EI-maintained [headless job fixture](../examples/host-adapter/headless-job-host.mjs) | Same `createEventIntelligence`, optional `createEventSourceRegistry` | Job ACL, queue transaction and durable receipt |
| EI-maintained [multi-org graph fixture](../examples/host-adapter/multi-org-graph-host.mjs) | Same `createEventIntelligence`, `createActivationDispatcher` | PostgreSQL host team/user authority, graph/agent resume routing, **atomic** SQL receipt/outbox |

**Do not confuse:** “two real consumers” with independently authored third-party certification. Muffin fork and Artemis Demo are maintained by the project owner; neither is independent validation. The other two examples are maintained by EI.

## Measured whole-file LOC, pinned to immutable source revisions

Physical LOC excludes only the final terminal newline; nonblank LOC excludes empty/whitespace-only lines. These are **whole files**, not selected glue blocks:

| Same-consumer comparison | Complete file | Before (physical / nonblank) | Candidate (physical / nonblank) | Savings |
| --- | --- | ---: | ---: | ---: |
| Muffin #17 canonical base `5f68a51bd99568bd8268d3d5ab9a1947b81d041b` → #18 `c32fcf963076306f456c66970fa4083e54bce313` | `agent/event-intelligence.ts` | **391 / 360** | **372 / 346** | **−19 / −14** (**4.9%** physical) |
| Artemis Demo `main` at `09bde81b7f6444cae6c22afb59020abe8d648d4e` → #124 `61cdc688db001548000c8891855b8b6b78f4f173` | `backend/src/host/event-intelligence/artemisEventIntelligenceHost.js` | **106 / 96** | **101 / 91** | **−5 / −5** (**4.7%** physical) |
| Combined **two consumer host-boundary files** | These two files only | **497 / 456** | **473 / 437** | **−24 / −19** (**4.8%** physical) |
| New EI production code, types, exports, runtime dependencies and forced host framework | Any EI library file | **0** | **0** | **0** new |

**Important:** These are different baselines. The *cross-consumer* sum is an honest aggregate of the two **within-consumer** improvements, **not** a claim that a Muffin adapter can be replaced with a 101-line Artemis adapter. The Artemis experiment updates only its existing EI package pin and matching npm lock/integrity. No new EI library implementation is credited to the saving, but the consumers' existing code outside these files remains their responsibility. No time-to-integrate, latency, cloud costs or end-to-end workload savings are measured.

The historical Muffin `0.11.0` baseline was **398 physical / 365 nonblank**; the current `372` candidate saves **26 physical**, but these sequential stages must not be conflated with a single isolated version experiment.

### Verified behavior and test limits

- **Muffin #18**: EI npm prerelease host conformance **passed**, but global DCO was red (real author signatures required), a separate installer/root-permission workflow failed and independent final-HEAD Codex review was unavailable due quota. Neither #17 nor #18 is merge-ready. Owner-only permissions and native tool taint remain inside the host, not EI.
- **Artemis Demo #124**: isolated GitHub Actions **“EI canonical embedded host canary” passed on `61cdc688db001548000c8891855b8b6b78f4f173`** after the test workflow was corrected to use the repository's **existing** `packages: read` + GitHub Actions token for its private *non-EI* dependency. It installs the actual public npm `0.12.0-next.0`, verifies its ESM export, and runs host lifecycle, real event wake and install-contract tests. **The full application CI and independent review are separate gates; PR is draft and unmerged.** Do not confuse a passing headless integration test with PG16 multiworker production or independent security certification.
- EI's own headless and multi-org reference tests exercise bounded host-owned receipt/replay, tenant denial, including PostgreSQL OS-process tests; they are **EI-maintained** and cannot substitute for a separately maintained external consumer.

### What code is genuinely duplicated?

The only *substantial* shared integration concepts identified are already implemented by the **same** canonical runtime-neutral EI facade, with no new application-specific exports:

1. Host-owned already-open MCP connection registry `mcp.list/subscribe`.
2. Host-owned continuation callback `runtime.deliver` and EI's existing opaque target / optional receipt helpers.
3. EI's storage/CEP/trigger lifecycle and `close/refresh`.
4. Optionally, for tool-enabled hosts only, `runtime.resolveContext/control` and portable `integration.bind`.

**Not safely deduplicable:** Muffin's Turn/principal type, native tool/approval/evidence tiers, Artemis's chat/user/tenant lookup, headless queue atomic enqueue, organization/graph ACL and outbox SQL. A generic `toMuffin`, `toArtemis`, team ACL, session or agent-execution shim in EI would **increase library weight or transfer host authority** rather than remove it. Across a *headless* host and a *tool-enabled* host there is inherently no shared native model-tool ABI to “lift out”.

### Repeatable integration recipe (portable, not a new library API)

A headless host with its **existing** authorized connection registry and transaction-safe work handler uses the public entry point directly:

```js
import {createEventIntelligence} from 'mcp-event-intelligence/embedded';

const ei = await createEventIntelligence({
  mcp: {list: () => host.connections(), subscribe: (onChange) => host.onConnections(onChange)},
  runtime: {
    // The host MUST recheck current target authority and atomically
    // persist its own work + receipt before acknowledging success.
    deliver: ({activation, packet, receiptId}) =>
      host.enqueueAuthorizedAndDeduplicated({activation, packet, receiptId}),
  },
});
try {
  // Use ei.host.scope(hostAuthenticatedScope), trigger lifecycle etc.
} finally {
  await ei.close();
}
```

This is an **illustrative wiring fragment, not a complete security implementation or LOC benchmark**. The host's `enqueueAuthorizedAndDeduplicated` and `connections` implementations are outside the snippet and are real work. A multi-agent/multi-company host may share one EI instance for many agents; it must still supply trusted scope, live target authorization and atomic host-side receipt semantics. A headless host must **not** be forced to register agent tools. A tool-enabled host uses the same integration plus `resolveContext/control` and `bind`, with host-defined native tool ABI and taint rules.

## Engineering verdict and exit gates

**Positive:** identical, named-runtime-free, shipping public EI facade works as a small headless lifecycle and as a native tool-enabled host, with unchanged public EI code. New generic Host Adapter Kit library production LOC: **0**. This is tangible consumer-code reduction and a portability exercise, not a substantial simplification yet.

**Negative:** no repeated **unimplemented** safe glue and no sizeable net ROI justify a second runtime framework or universal tool renderer. The observed 4.8% combined file reduction does **not** meet a meaningful adoption-cost objective by itself. Continue to measure full app+EI size, integration steps, latency p95/p99 isolated to the adapter, ops cost and independent developer time, and seek **independently developed** tool-enabled hosts before opening another public helper. Keep #269 portable bridge and ROI, #352 D, #353 independent production-scale gates and #362 acceptance unchecked until proven; never mark tests or DCO satisfied merely because the source files got shorter.

**No automatic merge, npm stable publication or deployment** is authorized by this report.
