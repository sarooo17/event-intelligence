# Stable v1.0.0 readiness review dossier (issue #41)

**Status as of 2026-11-06: 9/9 bounded SDK gates technically attested;
stable `1.0.0` remains UNPUBLISHED and NOT operator-authorized.**
The [live source-pinned ledger](v1-readiness.json) is the authority for
current signoffs; [PR #419](https://github.com/sarooo17/event-intelligence/pull/419)
signed all nine on reviewed `main` source
`f6923e87ba1744091b13bae30008c8a0b38c03cb`, then merged a
**ledger-only** change as `0332ef7cb3943b74468f12f25cb49c9c6a4b6407`.
The source/evidence reviewer is owner-delegated **ChatGPT GPT-6,
not an independent human auditor or production operator**.
This dossier is an evidence index, **not** permission to publish.

The [source-pinned 2026-11-04 evidence packet](v1-gate-evidence-packet-2026-11-04.md)
contains historical leads and PR-head CI/PG16/clean-room artifacts; the
[last full-database operator drill, #416](https://github.com/sarooo17/event-intelligence/pull/416)
and [negative-fixture/CI hardening, #418](https://github.com/sarooo17/event-intelligence/pull/418)
completed the final two prerequisites before #419. The published
`0.12.0-next.1` is a distinct npm `next` artifact, not this 1.0.0 source.

**Source freeze:** this documentation maintenance requires a new reviewed
`main` source ancestor and separate ledger-only reattestation of every
required row. The source-pinned strict gate **must** fail before that
reapproval, even though #419's prior bounded signoffs were 9/9.
The six optional external/enterprise criteria remain `blocked`; #317/#376
remain separately tracked, not silently certified.

This dossier separates the **reviewed bounded SDK evidence** from external
production claims that a stable-`1.0.0` package does **not** imply. In particular, the
last merged audit performance optimization, [PR #407](https://github.com/sarooo17/event-intelligence/pull/407),
has 12/12 exact-head workflows green, code review complete, PG16 audit
concurrency/tamper tests and a first-party Railway **1,000/1,000
5/s** source/worker/host test rechecked by another OS process.
Neither proves independent provider/host production certification or
a complete 10k/100k E47-C campaign; [#376](https://github.com/sarooo17/event-intelligence/issues/376)
remains 2/10.

## Nine reviewed SDK release gates — evidence index

| Stable-v1 gate | Reproducible evidence | Verified bounded SDK scope (per #419) |
| --- | --- | --- |
| `host-contract-and-package` | [#42](https://github.com/sarooo17/event-intelligence/issues/42), [#278](https://github.com/sarooo17/event-intelligence/pull/278), [#282](https://github.com/sarooo17/event-intelligence/pull/282); `scripts/check-packed-exports.mjs` and clean-room smoke | Exact 1.0.0 package identity, 12 public export/type paths, packed fresh-consumer conformance; no downstream auto-upgrade. |
| `security-revocation-and-tenant` | [#45](https://github.com/sarooo17/event-intelligence/issues/45), [#309](https://github.com/sarooo17/event-intelligence/pull/309), [#311](https://github.com/sarooo17/event-intelligence/pull/311), [#314](https://github.com/sarooo17/event-intelligence/pull/314), [#315](https://github.com/sarooo17/event-intelligence/pull/315); `docs/SECURITY-THREAT-MODEL-V1.md` | SDK owner/tenant isolation and strict opt-in shared PG session-fence negative checks; real deployed host OAuth/effects remain host-owned. |
| `pg-retention-audit` | [#378](https://github.com/sarooo17/event-intelligence/pull/378), [#407](https://github.com/sarooo17/event-intelligence/pull/407); `docs/POSTGRES-V1-NO-PRUNE-RETENTION-CONTRACT.md`, `test/postgres-v1-no-prune-retention.test.mjs`, `test/postgres-audit-head-append.test.mjs` | Actual PG16 lossless no-prune source/audit/dedup/receipt invariants and safe terminal-duplicate compaction; unbounded growth and off-host archival remain operator responsibilities. |
| `pg-chaos-recovery` | [#253](https://github.com/sarooo17/event-intelligence/pull/253), [#263](https://github.com/sarooo17/event-intelligence/pull/263), [#407](https://github.com/sarooo17/event-intelligence/pull/407); PG16 OS SIGKILL/post-host-effect and restart workflows | Isolated PG16 SIGKILL/restart, multiworker durable receipt and recovery evidence; no enterprise PG failover/RPO/RTO certificate. |
| `stored-state-upgrade` | [#258](https://github.com/sarooo17/event-intelligence/pull/258), [#378](https://github.com/sarooo17/event-intelligence/pull/378), `docs/EI-RELEASE-COMPATIBILITY.md`, `test/postgres-logical-dump-restore.test.mjs` | Actual PG16 **whole-database** cold clone and rollback into separate databases with signature refusal, tenant, nonempty audit, cursor/gap, receipt and fresh-epoch dedup; [#416](https://github.com/sarooo17/event-intelligence/pull/416) and [operator runbook](v1-postgres-operator-upgrade-rollback.md); no production off-host DR claim. |
| `packed-v1-and-breaking-notes` | `docs/releases/0.12.0-next.1-compatibility.md`, `docs/releases/v0.12.0-next.1.md`, version parity/packed checks | Candidate 1.0.0 lockfile/server parity, versioned compatibility notes, breaking API list and clean-room tarball; not a published npm artifact. |
| `downstream-pin-policy` | [#277](https://github.com/sarooo17/event-intelligence/pull/277), [#280](https://github.com/sarooo17/event-intelligence/pull/280); `docs/EI-RELEASE-COMPATIBILITY.md` | Explicit owner-controlled exact consumer version pins; Muffin/Artemis upgrades require separate consumer PRs, never implicit release side effects. |
| `full-explainability` | [#48](https://github.com/sarooo17/event-intelligence/issues/48), [#375](https://github.com/sarooo17/event-intelligence/pull/375), [#390](https://github.com/sarooo17/event-intelligence/pull/390), [#391](https://github.com/sarooo17/event-intelligence/pull/391), E48-A/B in [#376](https://github.com/sarooo17/event-intelligence/issues/376) | Bounded strict causal inspector with unknown/partial fidelity and PG16 negative source-gap checks; no third-party provider truth certification. |
| `semantic-triage` | [#49](https://github.com/sarooo17/event-intelligence/issues/49), [#330](https://github.com/sarooo17/event-intelligence/pull/330), [#374](https://github.com/sarooo17/event-intelligence/pull/374) | Opt-in evaluator, tenant/revision-scoped cache and durable reserved token/call/host-estimated-cost budgets; not actual provider billing or cancellation guarantee. |

**Candidate and evidence:** `package.json`, lockfile, `server.json`, Registry metadata, compatibility matrix and release notes share the **unpublished** 1.0.0 source identity. The candidate's reviewed packaged and PG16 evidence is recorded in #419. A green PR alone never authorizes npm: signoffs must continue to reference the exact newly reviewed `main` source after any non-ledger edit.

**Review order (historical):** The source-specific #419 attestations cover all
nine required gates. A future documentation-only source update must confirm
that implementation, package and release policy remain unchanged, rerun
exact-head tests and repeat **every** gate signoff in a ledger-only PR. No
gate changes status based solely on this dossier.

## Source-frozen signoff that can actually be verified

The committed ledger cannot contain the hash of its own final commit:
adding a SHA to the ledger would change that SHA. Instead use the
**already reviewed ancestor** for each gate.

1. Finalize the `1.0.0` candidate code, ABI, docs, notes, tests and
   release workflows; merge those changes to `main` **without publishing**.
2. Record the **actual reviewed main commit SHA** after freezing the code;
   rerun its exact-head CI and inspect the relevant artifacts. This SHA
   is the stable source being approved, not a prerelease run or a mutable tag.
3. In a **ledger-only** PR, for each independently reviewed requirement,
   add `status: "verified"` and `verification` with
   `reviewer`, ISO `date`, a specific `procedure` and
   `sourceCommitSha` (40-character immutable reviewed ancestor).
   Keep other gates blocked; do not invent a reviewer or claim consent.
4. The strict CLI verifies that the approved commit is an ancestor of
   the checked-out release commit **and that the entire repository is
   unchanged since that reviewed commit except
   `docs/releases/v1-readiness.json`**. New code, dependency,
   packaging, workflow or documentation changes invalidate the
   corresponding approval and require re-review. A regular CI green
   status or a URL listed under `evidence` never counts as signoff.
5. A version with build metadata is rejected **before** npm can strip or
   normalize it (for example `1.0.0+build-foo` must never behave as a
   prerelease bypass). This dossier authorizes **only the first `1.0.0`**;
   future stable releases must explicitly update the release policy rather
   than silently reuse an old 1.0 signoff.
6. Only then can the manual `Publish npm` workflow consider
   `1.0.0` on `main`, with `confirm=publish` and
   `expected_version=1.0.0`. The job independently runs the strict
   gate **before** any npm publish. Successful npm publication is
   required to start the separate `Release` workflow, which
   rechecks the same source-pinned strict gate **before** MCP Registry
   publication or stable GitHub release/tag. Merely changing a release
   workflow file can no longer mint a release.

Local read-only diagnostics (expected **eligible-for-manual-review** only on an unchanged, fully reattested final source; a temporary docs PR must stay blocked):

```sh
node scripts/evidence/v1-release-readiness.mjs --report
EI_RELEASE_SOURCE_SHA="$(git rev-parse HEAD)" \
  node scripts/evidence/v1-release-readiness.mjs --strict
node scripts/check-release-manifest.mjs
node scripts/check-release-compatibility-doc.mjs
```

**No tag, npm publication, automatic downstream pin update, enterprise
HA/SLO label, independent human signature or operator approval is created by this dossier.**
