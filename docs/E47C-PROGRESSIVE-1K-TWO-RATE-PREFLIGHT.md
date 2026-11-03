# E47-C progressive 1k-trigger two-rate preflight (NOT acceptance)

**Status: opt-in first-party staging campaign, not independent production SLO.**

The E47-C [#376](https://github.com/sarooo17/event-intelligence/issues/376)
acceptance requires 1k/10k/100k durable trigger populations, independently
operated source and host, two rates per population, >=1,000 source-linked
events per stage, independent raw cross-observer verification, database
physical I/O and production operator proof. This preflight purposefully does
not satisfy that acceptance.

## Why incremental

The existing source's private operator archive has a bounded 16 MiB
maximum, and the existing EI staging host and EI workers share PostgreSQL.
Scaling all six scenarios immediately would fill the source archive,
risk exhausting shared DB resources and create misleading claims of
independent host operation.

A successful 10-event real source→two worker→host pilot and separate-process
raw audit already exists. The next safe workload isolates **1,000 durable
triggers** in a fresh scoped namespace, with two explicit source append
rates (1 or 5 event/s). The initial **50 source events per rate** are
intentionally below the >=1,000-event campaign requirement; they are a
correctness/performance calibration, not the full gate. At most 250 source
events per invocation and no more than 1k triggers can be requested.
A later representative stage can increase the event budget only after
this raw evidence is checked. Historically, the initial runs used a
*serial append pacing target*; the open-loop extension below separately
measures offered arrival rate and source ACK-completion rate.

## Run in isolated one-shot Railway staging service with a private volume

The code uses ONLY existing first-party staging source `ei-source-oracle-staging`,
workers `ei-worker-a` and `ei-worker-b`, host `ei-benchmark` (as
delivery callback), PostgreSQL16 and the existing *source/worker/DB*
variable references from the successful pilot. Do not copy secret values
into the repo or logs. Never deploy this runner to a production/consumer
service. Operator must explicitly set:

```sh
EI_E47C_STAGE_CONFIRM=RUN_1000_FIRST_PARTY_STAGING
EI_E47C_STAGE_RATE=1
EI_E47C_STAGE_EVENTS=50
EI_E47C_ARTIFACT_DIR=/evidence
EI_E47C_SOURCE_SHA=<exact pinned git commit>
node scripts/validation/e47c-progressive-1k-stage-once.mjs
```

After recording original log/manifest SHA-256 and a successful
independent review, use a **fresh one-shot run** with
`EI_E47C_STAGE_RATE=5`. Each run has a unique scope ID and private
`ei-e47c-progressive-1k-r<rate>-<uuid>` subdirectory so there is no
automatic overwrite, cleanup or pruning.

## Evidence and limitations

Reports use `ei.e47c.progressive-1k-preflight.v1` and persist:
- source events with **provider-acknowledged sequence**, original timestamp,
  worker IDs, EI ingest→match and match→wake metrics and local monotonic
  **worker request→host receipt round-trip** timing
- actual durable PostgreSQL host receipts (first-party host's receipt
  database still shares EI PostgreSQL)
- original private source log archive, byte hashes, signed source frontier
  proof, event lineage and partial failure evidence
- target source pacing rate and measured append-completion rate; incomplete
  sample rows, source/host mismatches and bad numerical timing abort

A worker request→host receipt duration is **not** true upstream provider
event generation→EI ingress time. The stage deliberately does **not**
claim full source-to-business-effect end-to-end latency; do not relabel
local worker-to-receipt observations as that production SLO. Source logs are signed at
the *frontier-claim* level only, not across raw source archive bytes;
pin artifact SHA-256 from the original Railway runtime log and verify in a
separate process to avoid self-certification. The raw verifier from #394
requires the **full six-stage** matrix and must not accept this partial
preflight as complete.

The process's status `passed` means local first-party lineage and receipt
consistency on this narrowly scoped run, not independently operated
provider/host, reliable production availability, source log WORM guarantee,
host/external billing, physical PostgreSQL I/O attribution or SLO signoff.

Always preserve `acceptanceE47CVerified:false` and
`productionSloCertified:false`; **do not check E47-C** merely because
one or both 1k preflight runs pass.

## Re-audit a rate-specific run

Once an original deployment prints a successful
`event=ei_e47c_progressive_1k_stage` receipt, record its `runId`,
`artifactSha256` and `sourceLogSha256` **from Railway log outside the
volume**. Change the one-shot start command to:

```sh
node scripts/validation/e47c-progressive-1k-recheck.mjs
```

Pass `EI_E47C_PILOT_RUN_ID`, `EI_E47C_STAGE_RATE`,
`EI_E47C_EXPECTED_MANIFEST_SHA256` and
`EI_E47C_EXPECTED_SOURCE_LOG_SHA256` using those independently observed
values, and keep the original private `/evidence` volume mounted. The
verifier is **read-only**, never sends an event and never opens a PostgreSQL
connection. It recomputes original sample quantiles and authenticates the
historical signed frontier claim against the pinned raw source-log
bytes. No E47-C checkbox is automatically changed even on success.


## Open-loop source append pacing extension (follow-up preflight)

The initial serial source runs with 1,000 durable triggers and 50 events
per cohort verified against original private signed-frontier artifacts:
- requested **1 event/s**, achieved **0.874 completed appends/s**
- requested **5 events/s**, achieved **2.901 completed appends/s**

Those are serial-ACK completion rates, **not EI's maximum throughput**.
This update uses an absolute monotonic **offer** schedule rather than
sleeping after each provider ACK. A maximum of **4** in-flight source
requests is the default, configurable only within `1..8` via
`EI_E47C_MAX_INFLIGHT`. Any offered event rejected for backpressure,
a source failure, a missing durable provider ACK, or a missing source
sequence **fails the whole campaign**. No retry, rate adaptation, hidden
drop, or automatic promotion to E47-C certification is permitted.

Raw `offer.jsonl` records original offered index, source event ID,
planned monotonic offset, actual launch offset, lateness, completion offset
and explicit acceptance/refusal. The original source hash-chain still
verifies **provider accepted sequence and event content**; the offline
verifier cross-checks every offered ID against the source/worker/host
observations and recomputes offered-vs-completed rates from those original
per-event timestamps, plus peak in-flight requests. Open-loop offers from
one process do not establish an external independently-operated source;
the provider's own append implementation still serializes durable
writes internally.

Two distinct quantities must be kept separate:
- **Offered rate:** events launched per unit wall duration from the
  *independent* monotonic schedule. This is the input to the source
  endpoint, even when ACKs are slow.
- **Accepted completion rate:** source ACK completions per unit time.
  It measures how quickly the durable source returns; the provider may
  have queued requests and does not promise this equals offered rate.

In the **original #400 source-only open-loop calibration**, EI worker
ingestion remained serialized after polling. The concurrent-worker extension
below now separately measures bounded runner→EI ingestion; neither mode
measures continuous provider-produced→host external end-to-end latency. Those
limits, 50 events per rate, first-party source/host and shared PostgreSQL
still block E47-C acceptance.

Run exactly as above but set `EI_E47C_STAGE_RATE=5` and, for example,
`EI_E47C_MAX_INFLIGHT=4` in a separate isolated one-shot service
deployment with operator-only auto-watch disabled and a pinned SHA.
The read-only re-audit uses the same
`scripts/validation/e47c-progressive-1k-recheck.mjs` and separately
observed original manifest/source hashes. Legacy serial raw artifacts
remain re-auditable; the new manifest sets
`ratePacingIsSerialAppend:false` and
`offeredPacingIndependentOfAck:true` and requires the new original offer
artifact. No production/readiness checkbox changes automatically.


## Concurrent EI worker ingress — bounded two-phase calibration

After the source has durably appended/sealed events and the runner has
polled all acknowledged occurrences, the runner prewarms **both**
authenticated EI worker scope contexts via `/v1/recover`. It then
delivers original polled occurrences on an independent monotonic schedule
using `EI_E47C_STAGE_RATE` and `EI_E47C_WORKER_MAX_INFLIGHT=4`.
Permitted worker in-flight cap: **1–8**. Worker assignment alternates
two real distinct worker identities. Each response must acknowledge one
match and one persisted delivered wake; any failure or saturation makes
the campaign fail rather than silently lowering the offered rate.

Private `ingest.jsonl` contains every event ID, assigned worker ID,
monotonic scheduled/offered/completed offsets, original transition order,
and outcome. The independent read-only verifier checks all these raw
rows against the original source, EI event and durable host receipt,
recalculates worker ingress offered rate, ACK-completed rate and peak
in-flight count, and rejects fabricated missing or inconsistent samples.

**Important:** source append→poll is a completed **first phase**,
followed by runner→EI worker ingestion in the **second phase**. This is
not continuous provider→agent end-to-end latency. The existing host
receipt store shares EI PostgreSQL; no externally operated provider
or independently deployed host is implied. Database physical IO,
failure/recovery profiles and the full 1k/10k/100k x two-rate matrix
remain separate #376 acceptance requirements.

Example parameters on the existing isolated, one-shot staging service:

```sh
EI_E47C_STAGE_CONFIRM=RUN_1000_FIRST_PARTY_STAGING
EI_E47C_STAGE_RATE=5
EI_E47C_STAGE_EVENTS=50
EI_E47C_MAX_INFLIGHT=4
EI_E47C_WORKER_MAX_INFLIGHT=4
node scripts/validation/e47c-progressive-1k-stage-once.mjs
```

After the runner logs the original `runId`, manifest SHA-256 and
source-log SHA-256 **outside the writable private volume**, run
`e47c-progressive-1k-recheck.mjs` as a separate one-shot read-only
process with those externally observed hash pins. Both scripts must
always mark `acceptanceE47CVerified:false` and
`productionSloCertified:false`.

## Opt-in eventual delivery and bounded durable-settlement proof

The existing strict `/v1/events` calibration default remains
`EI_E47C_DELIVERY_MODE=immediate`: one match **and** one immediately delivered
host wake must appear in each response. This is deliberately stricter than
EI's durable delivery semantics and can fail even when the wake is later
persisted. Do **not** reinterpret an immediate ACK failure as a lost wake.

To test the actual asynchronous delivery semantics in a **separate, opt-in**
first-party staging run, set:

```sh
EI_E47C_DELIVERY_MODE=eventual
EI_E47C_DURABLE_DRAIN_MS=30000
EI_E47C_WORKER_MAX_INFLIGHT=8
```

`eventual` accepts a strict identity/one-match worker response when immediate
host delivery count is **0 or 1** with exactly corresponding timing samples.
It does **not** accept missing worker ACKs, 0/2 matches, forged worker IDs,
malformed timing or runner backpressure. The immutable open-loop offered-rate
schedule and explicit finite ingress cap are unchanged. Do not silently retry
or drop failed requests. The operator must choose the concurrency limit and
report it with the full offered/ACK completion rate and refusal count.

After every source-linked event is admitted, the runner polls **read-only**
exact-scope PostgreSQL host receipt counts for a bounded 1–120 second timeout.
It fails on missing/duplicate/overcounted wake or receipt identities and on
timeout. Passing the count alone is **never enough**: the subsequent strict
per-event original source→fired match→distinct wake→durable delivered record→
linked host receipt/attempt count reconciliation still runs. This remains one
shared PG16 first-party host, not independent enterprise host certification.

The new optional raw manifest is
`ei.e47c.progressive-1k-durable-preflight.v2`. It stores **worker request
completion** timing separately from an actual host receipt; an ACK with no
immediate delivery has `matchToWakeMs:null` and `immediateDelivered:false`.
The second-process raw verifier recomputes the sample coverage and explicitly
marks the missing immediate timing samples as **censored**. It does not claim
full provider→host end-to-end p99, independent source/business effect, 10k/100k
load, externally immutable off-host logs or E47-C certification. Older
`v1` manifest rechecks remain supported unchanged.

For a real test, first obtain exact-head green CI + independent review, then
pin the reviewed commit in the isolated one-shot service, explicitly enable
the new mode, preserve original source SHA and raw manifest hashes from the
**original** Railway runtime logs, and re-audit from a **separate process**.
If any stage fails, preserve failure evidence and leave E47-C unchecked.
