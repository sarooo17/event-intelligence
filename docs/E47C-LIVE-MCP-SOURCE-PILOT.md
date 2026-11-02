# E47-C — bounded live MCP source-linked pilot

**Purpose:** exercise a genuinely separately deployed first-party MCP Events
source, two Railway EI validation workers and the distinct benchmark host
service without mistaking the result for E47-C acceptance.

**Current state:** this is a new opt-in runner and test contract. No live
run is implied merely by merging the implementation. The full E47-C
acceptance in [#376](https://github.com/sarooo17/event-intelligence/issues/376)
requires 1k/10k/100k durable trigger populations, **two offered rates per
population**, at least 1,000 source events per cohort, real host receipts,
DB CPU/IO and memory attribution, independent original artifacts, p50/p95/p99,
and reviewer inspection. This *pilot* deliberately caps itself at **2–25**
events and **eventCount–1,000** trigger definitions and cannot satisfy E47-C.

## Exact services and trust boundaries

Intended environment: Railway `ei-validation / staging` with existing
`ei-source-oracle-staging` (private durable standalone MCP Events JSONL
source), `ei-worker-a`, `ei-worker-b`, `ei-benchmark` (separately
deployed host callback), and PostgreSQL16. All are **first-party**; the
benchmark host's receipt table shares the EI PostgreSQL database, so this
pilot does not establish independent enterprise host failure/storage domains.

The runner uses the same **scoped, pre-existing** `EI_LIVE_*`,
`EI_SOURCE_*`, `EI_TABLE_PREFIX`, `DATABASE_URL` variable references as
the successfully deployed E48-A source/PG oracle one-shot. No secrets,
public domains, extra LLM call or destructive DB operation are needed.
An additional private, durable `EI_E47C_ARTIFACT_DIR` mount and exact
`EI_E47C_SOURCE_SHA` are mandatory.

Run only in an isolated one-shot service/volume, not by modifying the
pinned evidence verifier service or live continuous worker commands:

```sh
EI_E47C_PILOT_EVENTS=10
EI_E47C_PILOT_TRIGGERS=10
EI_E47C_PILOT_EVENT_DELAY_MS=100
EI_E47C_ARTIFACT_DIR=/evidence
EI_E47C_SOURCE_SHA=<EXACT REVIEWED 40-HEX COMMIT>
node scripts/validation/live-e47c-source-linked-pilot-once.mjs
```

Use Railway variable references for the private source URL, source control
token, EI worker URLs/ingest token, PG URL and source oracle keys. Do not
copy their **resolved values** into an issue, PR, logs or source control.
At most one pilot should modify the bound first-party source at once:
source log rotation, unrelated test appends or revocation intentionally
abort this attempt rather than letting it pass with an altered frontier.

## Execution and observed evidence

1. Creates a new unique EI scope, registers bounded scoped trigger
   definitions for one MCP event with disjoint `slot` predicates.
2. Appends real events via the **separate source service**, seals it,
   then reads the actual paginated `events/poll` stream. Missing or
   truncated acknowledged events fail the run.
3. Ingests events alternately through two separate EI worker services.
   Requires exactly one real Pattern match/delivered wake and timing sample
   per source event. Measures monotonic request→host-receipt response time.
4. Reads each actual PostgreSQL fired match and durable wake receipt,
   independently reconciles source event ID/time to host receipt and
   checks duplicate attempt count.
5. Downloads the actual acknowledged original source log privately,
   verifies its SHA-256 and source checkpoint, then runs the independent
   Ed25519 source oracle (not the producer parser). It compares the original
   oracle's timestamp, name and payload to both the polled event and the
   provider's append acknowledgement, and retains the complete signed
   frontier plus signer pin for later independent verification.
6. Writes raw source/wake/worker JSONL, original source log, signed frontier
   and a versioned JSON manifest, each with SHA-256, exclusively to the
   private volume. On any later failure it additionally saves available
   partial samples and a failed/incomplete manifest; a failed campaign
   is never silently omitted from the evidence set.
   Logs expose run ID, counts and artifact hashes only.

Any partial pilot still leaves recorded source events and triggers in the
conservative **no-prune** PostgreSQL/standalone source log. It does not
delete them, silently retry the run in the same scope or manufacture
missing receipts.

## Unsupported claims

The generated report explicitly sets
`acceptanceE47CVerified:false` and
`productionSloCertified:false`. The request→receipt duration is **not**
provider append→ingest or independent end-to-end SLO. This pilot does NOT
measure 1k/10k/100k at two rates, full physical PG I/O attribution,
source producer process availability under sustained load, multi-tenant
host independence or PG primary failover/RPO/RTO. Its raw schema
`ei.e47c.live-pilot.v1` is intentionally **different from** the
six-stage E47-C verifier's full production schema; a passing pilot must
not be fed to that gate as if it were completed.


## Independent offline raw re-audit (post-pilot)

The first pilot was run on exact Git commit
`181812ee782493e063da360ef4103165899e75f4`, Railway deployment
`9034e86f-1a5b-45fd-8f27-aff00a460648`.
Its structured **out-of-band Railway runtime log** recorded:

- `runId=cd63f908-e94c-4b7f-81b5-cfc6f02ecf6a`
- `artifactSha256=690ec6002b2850566c92e79f75a7430b2db1f3fcda3a299c0fd324c602564dab`
- `sourceLogSha256=78a5886482434baca3b0a5744b8c03dadc687025cb25597d8a6e0bb09b02276b`
- 10/10 events and 10/10 host receipts with two EI workers; first-party staging, not production certification.

To perform a **new process** independent raw re-audit on the same
persistent private volume, pin these values from that original deployment log,
not by reading and copying mutable manifest fields:

```sh
EI_E47C_ARTIFACT_DIR=/evidence
EI_E47C_PILOT_RUN_ID=cd63f908-e94c-4b7f-81b5-cfc6f02ecf6a
EI_E47C_EXPECTED_MANIFEST_SHA256=690ec6002b2850566c92e79f75a7430b2db1f3fcda3a299c0fd324c602564dab
EI_E47C_EXPECTED_SOURCE_LOG_SHA256=78a5886482434baca3b0a5744b8c03dadc687025cb25597d8a6e0bb09b02276b
# Source key pin variables are provided by private Railway variable references:
# EI_SOURCE_TRUSTED_PUBLIC_KEY_PEM
# EI_SOURCE_TRUSTED_PUBLIC_KEY_SHA256
node scripts/validation/e47c-independent-pilot-recheck.mjs
```

The new process verifies raw byte hashes against these **external log pins**,
reconciles all source/worker/host receipt IDs and p50/p95/p99 samples, and
verifies the signed **historical frontier claim** from the previously bounded
byte buffer. The Ed25519 frontier signature **does not cover the source
archive hash**; the log hash remains anchored in the separately observed
Railway deployment log. These are first-party artifacts, not tamper-proof
remote storage or a third-party operator signature. A historical frontier
claim is not a currently fresh provider completeness guarantee.

A passing result always says
`acceptanceE47CVerified:false` and
`productionSloCertified:false`.
