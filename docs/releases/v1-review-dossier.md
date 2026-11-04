# Stable v1.0.0 readiness review dossier (issue #41)

**Status: review worklist, NOT a signoff or permission to publish.**
`main` contains the **unpublished** package source identity `1.0.0`, prepared by [#410](https://github.com/sarooo17/event-intelligence/pull/410); the previously published `0.12.0-next.1` is a separate npm `next` artifact.
The [source-pinned 2026-11-04 gate evidence packet](v1-gate-evidence-packet-2026-11-04.md) consolidates exact PR-head CI/PG16/clean-room runs and the four fastest reviewer checks; **all ledger statuses remain blocked pending actual manual approvals**.
The stable version in source **does not** imply npm `latest` publication or authorization.
Nine of nine **required** release ledger entries and six of six **optional**
deployment/enterprise category entries in
[`v1-readiness.json`](v1-readiness.json) remain `blocked`.
The implementation issues #42–#50 being closed does not change those
release-specific attestations. #317/#376 are independently tracked,
**optional for the generic SDK**, not silently certified.

This dossier separates already-existing, **reproducible evidence leads**
from what a stable-`1.0.0` candidate still requires. In particular, the
last merged audit performance optimization, [PR #407](https://github.com/sarooo17/event-intelligence/pull/407),
has 12/12 exact-head workflows green, code review complete, PG16 audit
concurrency/tamper tests and a first-party Railway **1,000/1,000
5/s** source/worker/host test rechecked by another OS process.
Neither proves independent provider/host production certification or
a complete 10k/100k E47-C campaign; [#376](https://github.com/sarooo17/event-intelligence/issues/376)
remains 2/10.

## Required SDK release gate review matrix

| Stable-v1 gate | Current reproducible lead | Still needed before `verified` |
| --- | --- | --- |
| `host-contract-and-package` | [#42](https://github.com/sarooo17/event-intelligence/issues/42), [#278](https://github.com/sarooo17/event-intelligence/pull/278), [#282](https://github.com/sarooo17/event-intelligence/pull/282); `scripts/check-packed-exports.mjs` and clean-room smoke | Pack **exact 1.0.0** source; audit every exported type/path from a fresh consumer and sign off exact commit |
| `security-revocation-and-tenant` | [#45](https://github.com/sarooo17/event-intelligence/issues/45), [#309](https://github.com/sarooo17/event-intelligence/pull/309), [#311](https://github.com/sarooo17/event-intelligence/pull/311), [#314](https://github.com/sarooo17/event-intelligence/pull/314), [#315](https://github.com/sarooo17/event-intelligence/pull/315); `docs/SECURITY-THREAT-MODEL-V1.md` | Review latest exact-source tenant/revoke/fence threat coverage and live negative tests; distinguish SDK authorization from host-owned permissions and optional #317 |
| `pg-retention-audit` | [#378](https://github.com/sarooo17/event-intelligence/pull/378), [#407](https://github.com/sarooo17/event-intelligence/pull/407); `docs/POSTGRES-V1-NO-PRUNE-RETENTION-CONTRACT.md`, `test/postgres-v1-no-prune-retention.test.mjs`, `test/postgres-audit-head-append.test.mjs` | Verify preserved audit/receipt/dedup hashes and all restoration invariants on final candidate; document **unbounded growth**, backups and capacity owner explicitly |
| `pg-chaos-recovery` | [#253](https://github.com/sarooo17/event-intelligence/pull/253), [#263](https://github.com/sarooo17/event-intelligence/pull/263), [#407](https://github.com/sarooo17/event-intelligence/pull/407); PG16 OS SIGKILL/post-host-effect and restart workflows | Attach green **exact candidate commit** CI artifacts with actual PG16 crashes, two workers and recovered receipts; manual reviewer confirms no uncounted host effects |
| `stored-state-upgrade` | [#258](https://github.com/sarooo17/event-intelligence/pull/258), [#378](https://github.com/sarooo17/event-intelligence/pull/378), `docs/EI-RELEASE-COMPATIBILITY.md`, `test/postgres-logical-dump-restore.test.mjs` | Review and execute a **complete operator backup/clone/restore or safe refusal** with candidate markers and receipt replay; never treat source-only archive as full-store restore |
| `packed-v1-and-breaking-notes` | `docs/releases/0.12.0-next.1-compatibility.md`, `docs/releases/v0.12.0-next.1.md`, version parity/packed checks | Produce and verify versioned **`1.0.0`** compatibility matrix, breaking/removal list, release notes, `server.json`/lockfile parity and the actual clean-room tarball |
| `downstream-pin-policy` | [#277](https://github.com/sarooo17/event-intelligence/pull/277), [#280](https://github.com/sarooo17/event-intelligence/pull/280); `docs/EI-RELEASE-COMPATIBILITY.md` | Record explicit owner approval to leave Muffin/Artemis/other downstream pins **unchanged** until their own reviewed integration/CI rollout; no automatic consumer change |
| `full-explainability` | [#48](https://github.com/sarooo17/event-intelligence/issues/48), [#375](https://github.com/sarooo17/event-intelligence/pull/375), [#390](https://github.com/sarooo17/event-intelligence/pull/390), [#391](https://github.com/sarooo17/event-intelligence/pull/391), E48-A/B in [#376](https://github.com/sarooo17/event-intelligence/issues/376) | Review final candidate's strict fail-closed fidelity, partial/unknown, source frontier, limits/latency; approve the **bounded SDK** guarantee only, not external provider truth |
| `semantic-triage` | [#49](https://github.com/sarooo17/event-intelligence/issues/49), [#330](https://github.com/sarooo17/event-intelligence/pull/330), [#374](https://github.com/sarooo17/event-intelligence/pull/374) | Review opt-in evaluator, scoped durable reserved token/cost limits, cache identity, timeout/unknown no-refund across two pools; **do not** claim settled OpenAI spend or remote cancellation (#376) |

**Stable source candidate prep:** `package.json`, both root/package-lock identities, `server.json`, Registry docs, `docs/releases/1.0.0-compatibility.md` and `docs/releases/v1.0.0.md` now describe **one unpublished identity**. The version-specific checker and clean-room tests must run on the exact candidate PR. A reviewed PR alone is not a named release-gate attestation; every row remains blocked until the frozen reviewed main ancestor is approved separately.

The **quickest meaningful review** starts with `full-explainability`,
`semantic-triage` and `downstream-pin-policy`, then
`security-revocation-and-tenant`, `pg-retention-audit`,
`pg-chaos-recovery` and `stored-state-upgrade`. The two package-specific
gates must be rechecked after the final exact `1.0.0` identity is built.
No gate changes status based solely on this dossier.

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

Local read-only diagnostics (currently expected to report **blocked**):

```sh
node scripts/evidence/v1-release-readiness.mjs --report
EI_RELEASE_SOURCE_SHA="$(git rev-parse HEAD)" \
  node scripts/evidence/v1-release-readiness.mjs --strict
node scripts/check-release-manifest.mjs
node scripts/check-release-compatibility-doc.mjs
```

**No tag, npm publication, automatic downstream pin update, enterprise
HA/SLO label, reviewer signature or approval is created by this dossier.**
