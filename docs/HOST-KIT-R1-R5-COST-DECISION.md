# Host Adapter Kit R1/R5: whole-consumer cost and one-time binder overhead

**Status:** bounded EI-maintained measurement, NOT third-party onboarding,
production HA, or an independently measured developer-hours study.
Parent tracker: [#269](https://github.com/sarooo17/event-intelligence/issues/269).
This document does not ship a new SDK, authorization service, session layer or
runtime, and does not imply stable-v1 certification.

## Decisions that follow from actual source

1. No new Host Adapter Kit public API is justified yet. Existing
   `createEventIntelligence({mcp,runtime})` with `ei.bind` already handles
   capability allowlisting, preflight-before-registration and lifecycle.
   Host owns identity, authorization, approval, tool presentation, receipt
   outbox, durable job enqueue and MCP connection credentials. Moving those
   into EI merely shifts implementation cost and compromises neutrality.
2. Two genuinely distinct real consumers are tracked by the original
   [cross-consumer audit](HOST-ADAPTER-CROSS-CONSUMER-AUDIT.md):
   Muffin (native tool host) and Artemis Demo (headless). Muffin's whole
   adapter on a prior candidate is **391→372 physical LOC**; Artemis's
   lifecycle adapter **106→101 physical LOC**. These are **unmerged separate
   consumer candidates at the time of that audit**, and the Artemis 101-line
   file does not include the app's wake-service/security/trigger-UI code.
   They are not two independent *tool-enabled* consumers and cannot alone
   prove universal toolkit integration ROI.
3. A **same EI-maintained host**, exact modules verified by Git blob SHA in
   `examples/host-adapter/portable-runtime-lab/cost-report.mjs`:
   host 130 physical/127 nonblank, direct manual bridge 50/49, canonical
   binder bridge 40/39. The **whole host plus ONE bridge** is 180→170
   physical and 176→166 nonblank (**10 LOC, ~5.56%** total reduction).
   Full bridge files, not only one facade call, are counted. Both variants
   have **zero added EI production/type/export LOC**, identical runtime
   dependencies and one shared published npm lockfile.
4. The portable-runtime lab's pinned `0.12.0-next.0` lock contains
   **20 package entries including the project root**, one direct dependency
   `mcp-event-intelligence`. Both alternatives depend on this *same* EI
   package and already-existing host app. This is NOT a measurement of
   incremental EI cost versus a project that has no EI installed.
5. Minimal evaluated installation commands:
   `cd examples/host-adapter/portable-runtime-lab`,
   `npm ci --ignore-scripts --no-audit --no-fund`,
   `npm test`. **Real adoption** additionally requires a host-side MCP
   Events connection, credentials/session revocation, current principal/tenant
   policy, native tool ABI, durable/atomic outbox and work enqueue, deployment,
   and monitoring. The lab mocks its receipts in process.
6. Manual and binder variants have different **one-time registration**
   functions. That is the only part `ei.bind` can affect at initial exposure;
   actual per-call `tool.execute` uses the same portable closure once
   installed. The previous `benchmark.mjs` times host+EI-store tool calls,
   therefore cannot isolate a binding benefit. Run
   `node benchmark-bind.mjs` for a controlled **one-time eight-tool
   registration** microbenchmark. It uses **real public EI tool metadata**,
   validates unknown IDs before side effects, warmups 700, samples 2500
   per round and manual→binder→binder→manual order; reports observed p50/p95/p99.
   Real CI timing differences, especially sub-millisecond, are sensitive
   to JIT/GC/cache and must never become production SLOs or speed claims.

## Reproducibility

```sh
cd examples/host-adapter/portable-runtime-lab
npm ci --ignore-scripts --no-audit --no-fund
npm test
node cost-report.mjs
node benchmark-bind.mjs
node benchmark.mjs
```

The `host-tool-runtime-lab` CI job checks these JSON schemas and uploads
artifacts `integration-cost-report.json`,
`registration-measurements.json` and `adapter-measurements.json`.
Do not quote numbers from an unverified/failed job. The source report
fails closed if any counted whole module is modified without a new review.

## Remaining #269 gates

- R1: whole-file **same-host** LOC and direct-package footprint are bounded
  and reproducible; independently timed adoption, production-host incremental
  operational cost, and two unlike real tool-enabled app comparisons remain
  **unproven**. Thus R1 is not fully satisfied.
- R3: the non-Muffin independent real tool-enabled adopter is still missing.
- R4: real 1/10/100/1000 tenant memory/activation-worker scale and provider
  resilience are separate from these microbenchmarks.
- R5: registration-only timing can be isolated and real CI emitted, but
  end-to-end cloud cost, durable PG16 host setup overhead and independent
  application-scale RSS remain incomplete. No fabricated developer time.
- R6: record an explicit **no-new-generic-API** result for the current
  evidence (positive 10-line local saving but no verified broad adoption ROI);
  do not mark the entire v1 Host Kit complete or silently waive security
  release gate #317 and reliability gate #47.
