# E48-B raw evidence — second-process replay of one real Railway campaign

Evidence already measured: `ei-e48b-inspector-once` Railway deployment
`bfb4c523-cecd-44a6-b503-ad8c29f24dd9` using merged source SHA
`2490030c62cb23009b0decb14ffabce61997e5eb`. Main runner emitted
`ei_e48b_full_inspector status=passed` with exactly 1k/10k/100k candidates,
900 real full-Inspector measurements, 150 remote host receipts, real PG16
pool contention and backend termination/recovery, and raw artifact retention.

Pinned manifest SHA-256:

`31c95ac26fef3826d7dd6b3b95d0de932d1ba46d036722ed13ad8cc5b90e6d07`

The main benchmark's final success JSON alone is **not** an independently
recomputed measurement; use the separate operator verifier:

```text
EI_E48B_ARTIFACT_DIR=/evidence
EI_E48B_EXPECTED_MANIFEST_SHA256=31c95ac26fef3826d7dd6b3b95d0de932d1ba46d036722ed13ad8cc5b90e6d07
EI_E48B_MEASURED_SOURCE_SHA=2490030c62cb23009b0decb14ffabce61997e5eb
node scripts/validation/verify-e48b-raw-evidence-once.mjs
```

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
