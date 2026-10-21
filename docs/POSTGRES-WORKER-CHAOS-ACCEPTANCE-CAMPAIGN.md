# Reproducible PostgreSQL independent-worker chaos campaign (#47)

**Status:** This workflow produces a single attestable acceptance-evidence
artifact from actual tests and rejects omissions. It does not claim remote
multi-zone production SLOs, actual database primary failover or provider
network partitions.

## Operator-triggerable acceptance campaign

The `PostgreSQL Independent Worker Chaos Acceptance` GitHub Actions workflow
runs against isolated PG16, with Node 22 and exactly pinned pg@8.16.3. It
checks out a specified Git commit and verifies the SHA rather than trusting
an artifact label. A scoped PR run exercises the entire campaign before
this code can be merged. Operators can subsequently run it manually on a
trusted, reviewed branch.

The workflow executes:

1. **40 real worker process SIGKILLs** across four independently isolated
   ten-round cohorts. Each original match must be durably committed; two
   independent successor OS workers contend for its wake. The fixture host
   must report exactly 40 logical matches, receipts, calls and effects,
   with zero unaccounted duplicate attempts. The summary validates every
   round's SIGKILL PID, two independent successor PIDs and receipt.
2. **20 independent SIGKILLs after host effect but before EI receipt**,
   with 20 distinct host effects, 40 host delivery attempts and 20 observed
   idempotent retry attempts. This matters: counting retry attempts as
   duplicate effects is wrong, and ignoring repeated callbacks is also
   wrong. Host idempotency remains a prerequisite.
3. **12 independent physical pool rebalance rounds**, verifying wake and
   partition lease owner/generation/expiry, stale ABA fencing, independent
   receipts and no delivered-wake redispatch.
4. **Four live PostgreSQL backend termination rounds**, interrupting
   active SQL with `pg_terminate_backend` and verifying fence/receipt
   continuity via fresh client pools.

The post-run aggregate verifies exact raw JSON counts, boundary evidence,
actual independent TAP success, Git SHA, PostgreSQL version and driver
identity. It writes a `completed` manifest only *after* all four
commands exit successfully. The successful GitHub Actions artifact includes
raw process evidence and TAP transcripts; a failure does not produce a
success-shaped artifact. The manifest also records SHA-256 digests of the
rebalance/backend TAP files.

## Interpretation

These are **bounded repeated actual process faults on a disposable single
PostgreSQL 16 service**, not continuous real-world 24h availability
monitoring. The provider emits fixture MCP occurrences rather than operating
over remote transport. The host ledger is test-only and idempotent, not
Muffin/Artemis or arbitrary HTTP/ERP writes. Backend termination is one
socket, not database restart/replica promotion or split-brain.

Once the run has completed and source-bound artifact is inspected, it can
support the top-level #47 acceptance on repeated worker crash/rebalance
**together with earlier independent failure-boundary tests**. The
transferred #21 long-soak/provider-network/partition acceptance should
remain unchecked until a separate longer real outage campaign exists.
No production p99 or provider/host/PG cost SLO is certified.
