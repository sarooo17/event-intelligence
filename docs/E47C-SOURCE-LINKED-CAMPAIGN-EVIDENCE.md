# E47-C — Source-linked external campaign raw-evidence gate

**Status: IMPLEMENTATION SLICE / NOT CERTIFIED.** This is a fail-closed,
**read-only** cross-observer consistency checker for the optional production
validation tracked by [#376](https://github.com/sarooo17/event-intelligence/issues/376).
It neither runs a workload nor verifies an external human operator or source's
business truth. E47-C stays **unchecked** until independently operated
campaign artifacts and measured DB/host/network attribution are actually
collected and reviewed.

## Why the old benchmark is not sufficient

The existing `ei-benchmark` process acts as both synthetic MCP-shaped
producer and wake-receipt host. Its receipt ledger shares the EI PostgreSQL
service. The gateway in `benchmark-service.mjs` correctly flags these as
`externalProviderMeasured:false`, missing `providerToIngest`, a combined
provider/host failure domain, and missing PG service CPU attribution. The
large 1k/10k/100k benchmark is useful bounded SDK evidence **but not the
source-linked E47-C external campaign**. This preflight does not retroactively
reclassify old synthetic measurements.

## What the new checker requires

Input is an isolated **private raw-artifact directory** holding `manifest.json`
and 18 exact original JSONL artifacts: source log observations, separate host
receipt observations and EI stage timing observations for each of six
cardinality/rate combinations. Cardinalities must be 1k, 10k and 100k,
with **two distinct positive offered event rates for each cardinality**,
at least 1,000 events per stage and an observed duration of at least 60s.

Every stage in `manifest.stages` declares `sourceRaw`, `hostRaw`, `eiRaw`,
each `{file,sha256}`. The manifest identifies pinned 40-hex Git SHA,
deployed source + host (different service IDs), two independently identified
EI workers, source oracle log SHA and staging deployment IDs. `sourceRaw`
records unique `eventId` and `sourceSequence`; `hostRaw` records unique
`eventId`, `wakeId`, `runtimeReceiptId`; `eiRaw` records these three IDs,
`workerId` plus `ingestToMatchMs`, `matchToWakeMs`, `endToEndMs`. A
monotonic, **single-observer** measurement clock must be used for each duration,
not cross-container timestamp subtraction.

Each stage additionally records `expectedEventCount`, `durationSeconds`,
`requestedRatePerSecond`, `triggerCount`, `duplicateHostEffects:0`,
`unsettledWakeCount:0`, `postgres:{cpuUserMicros,ioReadBlocks,ioHitBlocks,
storageBytes}`, `rssPeakBytes` and `latency` summaries containing
`p50,p95,p99` for all three measured stages.

Run:
```bash
node scripts/validation/e47c-evidence-cli.mjs /private/e47c-campaign
```

The verifier checks original **byte SHA-256**, strict JSONL and bounded
filenames/size, unique source sequences, source↔EI↔host ID linkage,
wake/receipt uniqueness across all stages, source/host/measurement counts,
two different EI worker identities and independently recalculated nearest-rank
p50/p95/p99. It refuses fabricated healthy percentiles when samples were
censored or acknowledgements don't match. It emits
`status:consistent-requires-independent-review` only for **internally
consistent data**; `acceptanceVerified:false` and
`productionSloCertified:false` are immutable.

## Deliberate remaining independent evidence requirements

1. A real separate MCP source must supply pinned raw source-log/oracle proof,
   replay rules and verifiable signing key. The SHA in the manifest is
   an input claim, **not** a signature check or an independently verified
   provider integrity certificate.
2. The external host must really own wake receipt/effect persistence;
   self-declared distinct service IDs are **not** proof of independent
   operators, storage or failure domains. A reviewer must inspect actual
   deployment and private receipt backing store.
3. Record trustworthy per-request physical PostgreSQL I/O attribution,
   queue/backpressure, real source arrival/ingress separation, DB CPU/memory
   from platform metrics, error-rate/failed runs, multiple offered rates,
   environmental conditions and signed raw archive provenance.
4. E47-B additionally requires >=600s campaigns and real PG primary
   failover with measured RPO/RTO; E47-A needs off-host/WORM integrity
   and deletion-floor proofs. The source-linked E47-C preflight does not
   substitute for those distinct acceptance criteria.

No third-party model calls or secret values are involved. Test fixtures
under `test/e47c-source-linked-evidence.test.mjs` are **synthetic**
adversarial validator tests; they never become operational evidence.
