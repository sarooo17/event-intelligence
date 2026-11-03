# E47-C explicit 1,000-event first-party campaign (NOT enterprise acceptance)

The optional 1,000-event stage extends the proven 1k-trigger/250-event 5/s
two-EI-worker staged flow. It has its **own operator confirmation** and
**does not** silently expand the 250-event default, disable backpressure,
change EI runtime APIs, imply provider independence or certify a full SLO.

## Isolated operator-only mode

Only on the existing private `ei-validation/staging` one-shot service, with
its pre-existing service references to the isolated, authenticated source,
worker A, worker B, host and PG16:

```text
EI_E47C_STAGE_CONFIRM=RUN_1000_EVENTS_FIRST_PARTY_STAGING
EI_E47C_STAGE_EVENTS=1000
EI_E47C_STAGE_RATE=5
EI_E47C_DELIVERY_MODE=eventual
EI_E47C_DURABLE_DRAIN_MS=30000
EI_E47C_MAX_INFLIGHT=4
EI_E47C_WORKER_MAX_INFLIGHT=8
EI_E47C_SOURCE_SHA=<exact independently reviewed and merged main commit>
EI_E47C_ARTIFACT_DIR=/evidence
```

Run `node scripts/validation/e47c-progressive-1k-stage-once.mjs` once, only
after the exact-head PR CI, PG16/fault tests and external review are green.
The stage refuses any count other than **exactly 1,000** or delivery mode
other than `eventual`. The older confirmation
`RUN_1000_FIRST_PARTY_STAGING` continues to cap the population to 250
events; the bounded scheduler's own default stays at 250. Rate is 1 or
5 source event offers/s; start with 5/s in a new unique scope.
The two offer phases (source→durable append, then EI ingestion) are **not
continuous provider→host load**. Each at 5/s requires about 200 seconds of
offers before verification. Real completion time may be longer.

**Bounded safety before any trigger register or source append:**
- Minimum 32 MiB free on the existing private persistent evidence volume
- Existing authenticated first-party source archive strictly below 14 MiB
  of its fixed 16 MiB process/log limit, leaving at least 2 MiB reserve
- Fixed 1k trigger count, two worker identities, distinct source/host
  endpoints, PG16, hard source/worker in-flight caps (1–8)
- All 1k source offers, source ACKs, EI ingress ACKs and durable
  host settlements must be accounted for. Over-capacity offers explicitly
  fail; no adaptive rate, retries or discarded event IDs are hidden

The v3 manifest (`ei.e47c.progressive-1k-durable-preflight.v3`) records
all 1,000 original source-to-EI-to-host witness rows, requested and actual
offer/completion rates, measured capped worker concurrency, a bounded
read-only wait for 1,000 unique host receipts **and** 1,000 completed EI
delivery records, and strict per-event identity/attempt verification.
The older 50/250 event v1/v2 manifest and raw verifier remain supported.

All original artifacts are private `O_EXCL` files. Pin original
`artifactSha256` and `sourceLogSha256` from the **original Railway runtime
log outside the writable volume**, not from the manifest itself. Use
`e47c-progressive-1k-recheck.mjs` in a *separate* one-shot deployment and
the exact original `EI_E47C_PILOT_RUN_ID`, rate and both SHA256 pins.
The independent verifier refuses any missing source/host/worker rows,
duplicate receipts, distorted rates or the wrong count. It labels late
immediate wake timing samples as censored rather than inventing an
end-to-end p99.

## Not covered

This only exercises **1k triggers and 1k first-party source-linked
events at one rate**. An independently run second rate, **10k and 100k**
trigger populations, multi-rate representative load, true third-party
operated provider and host, real business-effect end-to-end p99,
physical DB CPU/I/O attribution, fault runs and externally immutable WORM
archive are **not** established here. A passed first-party v3 is not E47-C
acceptance and cannot check any of E47-A/B/C or E317. All reports must
retain `productionSloCertified:false` and
`acceptanceE47CVerified:false`.
