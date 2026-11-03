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
EI_E47C_WORKER_MAX_INFLIGHT=20
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
  endpoints and PG16; source append cap stays 1–8, while the **explicit**
  1k worker ingress cap is separately bounded to 1–20 (legacy 250-event
  mode and scheduler defaults remain limited to 1–8)
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

## Measured first 1k cohort failure and next capacity experiment

The first actual first-party Railway 1k-trigger/1k-event **5/s** campaign
(`c1bc064d-ab3b-4747-85a9-33b3043c5d8a`, scope run
`8e1522eb-1d3b-4620-88f1-d56f309b36e6`) correctly **FAILED**
with a hard worker in-flight cap of **8**. All 1k source events were
durably appended but **760/1,000** were accepted by EI, with **240
explicit runner backpressure refusals**, 0 worker request failures. A
separate exact-scope read-only PG16 query confirmed 760 distinct
matches, wakes and durable host effects (no duplicate accepted effects).
Original failed partial artifacts remain privately retained, not
externally signed or independently immutable.

Request durations from the 760 accepted workers (thus excluding refusal
latency) were p50 1,554.605 ms / p95 3,025.038 ms / p99 3,338.991 ms.
The refusal count increased at larger source-order indices.
With 5 requests/s offered, a fixed cap of 8 admits at most 1.6 seconds
of steady in-flight residence. **A second fresh, explicitly opted-in
cap-20 cohort** probes whether bounded overlap addresses observed
backpressure without altering the source rate or hiding refusals.
It is a *new test*, not retrospective reinterpretation of the first
failed 1k campaign; if any request is refused or not reconciled, the
campaign must again fail.

`scripts/validation/e47c-partial-ingress-diagnose.mjs` supports an
exactly-1k failed cohort only with explicit first-party/eventual/source
evidence flags and 1k accepted source offers. It reads bounded raw files
from the existing private volume and emits only safe aggregate worker
aliases/reason categories; it **cannot** certify the mutable original
volume or reconstruct signed provider truth after a failed partial run.
