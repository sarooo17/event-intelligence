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
this raw evidence is checked. The provided rate is a *serial append pacing
target*, not an independently measured offered arrival distribution;
the manifest also reports measured source append completion rate.

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

EI **worker ingestion remains serialized after source polling** in this
calibration runner; it cannot yet measure multi-concurrent provider→EI
ingress or provider-produced→host external end-to-end latency. Those
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
