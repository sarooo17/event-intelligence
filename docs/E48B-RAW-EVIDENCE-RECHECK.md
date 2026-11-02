# E48-B raw evidence — second-process replay of one real Railway campaign

The original Railway benchmark (deployment `bfb4c523-cecd-44a6-b503-ad8c29f24dd9`,
source SHA `2490030c62cb23009b0decb14ffabce61997e5eb`,
manifest SHA-256 `31c95ac26fef3826d7dd6b3b95d0de932d1ba46d036722ed13ad8cc5b90e6d07`)
**passed as a measurement**, but cannot pass this new independent raw
audit: its stage files did not retain receipt-row identities, worker request
intervals, or manifest-pinned stage-file digests. Do not treat that original
manifest as independently certified, or fabricate the missing observations.

**Required new campaign** (isolated staging only):

1. Merge the reviewed collector/verifier changes and pin
   `ei-e48b-inspector-once` to the resulting exact commit SHA.
2. Run `node scripts/validation/live-e48b-inspector-once.mjs` with its
   existing scoped Railway secrets and private `/evidence` volume.
   Require `ei_e48b_full_inspector status=passed`; record the new
   `sourceSha`, `manifestSha256`, deployment ID and stage counts.
3. Using the same persisted evidence volume (mounted writable by Railway,
   but accessed **read-only by the verifier**) in a new OS process, execute
   the verifier using those NEW, matching values:

```sh
EI_E48B_ARTIFACT_DIR=/evidence \
EI_E48B_EXPECTED_MANIFEST_SHA256=<NEW_VERIFIED_MANIFEST_SHA256> \
EI_E48B_MEASURED_SOURCE_SHA=<NEW_EXACT_COLLECTOR_COMMIT_SHA> \
node scripts/validation/verify-e48b-raw-evidence-once.mjs
```

4. Keep E48-B unchecked unless the verifier returns
   `ei_e48b_raw_evidence_independent_recheck status=passed`, with
   artifact hashes recorded in the issue. Any error requires truthful
   correction and a fresh campaign, not rewriting immutable raw artifacts.

This verifier runs as a **separate OS process** on the exact same isolated
persistent Railway evidence volume; it never connects to PostgreSQL or
worker hosts, changes configurations, opens source secrets, or executes
workloads. It checks pinned manifest bytes and filename; all three raw
stage JSON files; the exact per-call latency samples; p50/p95/p99
recalculated **without calling the original profiler's percentile
function**; 0 unexpected strict inspection refusals; CPU/RSS measurements;
exclusive-table PostgreSQL I/O and actual SQL buffer plan; simultaneous
remote host-effect acknowledgements and distinct receipt/worker counts;
plus the separately saved full raw slow/failed-PG fault probe and
the real isolated `pg_terminate_backend` success. It prints only
redacted counts and SHA-256 digests, never raw tenant/scope or credentials.

The verifier does not demonstrate independently operated enterprise host
security (that's E317) or a future production SLO; it proves the **specific
live E48-B dataset** is complete, internally consistent and reproducibly
summarized. The PG table read counters are scoped to dedicated test tables,
not automatically every statement issued by a full Inspector inspection.
Their async publication and any external system workload are recorded in
the raw artifact limitations. Keep E48-B unchecked until this secondary
verification returns PASS.
