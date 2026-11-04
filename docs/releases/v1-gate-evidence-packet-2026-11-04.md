# v1.0.0 release gate evidence packet — 2026-11-04 (issue #41)

**STATUS: source-frozen evidence collection, NOT a manual release attestation.**
Do not mark `docs/releases/v1-readiness.json` entries verified solely because
this packet, GitHub Actions or an AI code review exists. No npm publication,
stable tag, MCP Registry listing, consumer pin change, production/enterprise
certificate or independent human signoff is performed here.

## Reproducible baseline and source boundary

- Candidate identity prepared and squash-merged by [PR #410](https://github.com/sarooo17/event-intelligence/pull/410). Exact **reviewed PR HEAD**:
  `4284f356235269bda9c3d8cf0e7ef7d1da780b8a`;
  corresponding **main merge commit**:
  `4b6200c15e91af8efcb62020f329364d8a49ea78`.
  The source version at this baseline is `mcp-event-intelligence@1.0.0`,
  **UNPUBLISHED**. This packet PR changes docs and the Clean-room Smoke
  pull-request path filter; Quickstart/release-doc changes now run packed
  consumer checks. There is no runtime or package behavior change.
  The signed `sourceCommitSha` must be the **actual final merged/reviewed main
  ancestor after all source changes are frozen**, not the stale #410 SHA.
- Independent automated Codex review on the **exact PR HEAD** found no
  remaining major issues and zero unresolved threads. **This is not a
  human release-owner approval.**
- All eight relevant PR HEAD workflows completed **successfully**:

| Exact-head workflow | GitHub Actions evidence |
| --- | --- |
| Full CI (including actual PG16 `postgres-ha` job) | [41737399386](https://github.com/sarooo17/event-intelligence/actions/runs/41737399386) |
| Clean-room Smoke (install packed tarball in fresh consumer projects) | [41737399153](https://github.com/sarooo17/event-intelligence/actions/runs/41737399153) |
| Public Release Check (pack/export/manifest/security; never publish) | [41737399176](https://github.com/sarooo17/event-intelligence/actions/runs/41737399176) |
| Security Scan | [41737399685](https://github.com/sarooo17/event-intelligence/actions/runs/41737399685) |
| MCP Launch Check | [41737399426](https://github.com/sarooo17/event-intelligence/actions/runs/41737399426) |
| Railway validation PostgreSQL smoke | [41737399583](https://github.com/sarooo17/event-intelligence/actions/runs/41737399583) |
| PostgreSQL OS Crash-Recovery Soak Evidence | [41737399551](https://github.com/sarooo17/event-intelligence/actions/runs/41737399551) |
| PostgreSQL Post-Host-Effect SIGKILL Evidence | [41737399361](https://github.com/sarooo17/event-intelligence/actions/runs/41737399361) |

The CI test suite's `postgres-ha` job ran **PostgreSQL 16.15** and
reported **139 passed tests** (this specific PG job; not the count of
all independent workflows). `pg-os-matched-contenders` was **skipped**
in the same run; do not describe it as passed. Different checks cover
separate failure paths.

## Four prioritized required gates — concrete evidence and remaining signoff

### 1. `host-contract-and-package` — evidence collected, status BLOCKED

**Observed on exact `1.0.0` source:** [Public Release Check](https://github.com/sarooo17/event-intelligence/actions/runs/41737399176)
ran `npm run pack:check` and `scripts/check-packed-exports.mjs`,
reporting `Packed export parity OK: 12 public paths verified`.
The [Clean-room Smoke](https://github.com/sarooo17/event-intelligence/actions/runs/41737399153)
built a tarball at version `1.0.0`, installed it in empty Node projects,
imported the root, host and PostgreSQL exports, tested the CLI identity,
two host styles, headless lifecycle, canonical trigger example, managed
consumer and multi-target host. An isolated TypeScript consumer compiled
the typed trigger example with `tsc --noEmit --strict`.

**Reviewer action:** inspect actual tarball export/type inventory and the
reviewed `1.0.0` public contract; attest exact source, build and
no undocumented/unsafe host-owned write action. Existing tests are
EI-maintained consumer-shaped fixtures, NOT independent authored
third-party integrations (that is an optional gate).

### 2. `full-explainability` — evidence collected, status BLOCKED

**Observed on actual PG16:** in [CI PG16 job](https://github.com/sarooo17/event-intelligence/actions/runs/41737399386),
the signed source frontier / selected-candidate checks passed for
tenant+revision fencing; replay/gap handling cannot manufacture
`candidate_impossible` from an untrusted cursor or stale frontier.
The full `TriggerInspector` executed against PostgreSQL and bounded
cost/latency tests also passed. Existing separately reviewed
[PR #375](https://github.com/sarooo17/event-intelligence/pull/375)
and [PR #391](https://github.com/sarooo17/event-intelligence/pull/391),
plus [#376 E48-A/B](https://github.com/sarooo17/event-intelligence/issues/376),
contain first-party separately deployed signed-source and 1k/10k/100k
inspector staging evidence with second-process raw recheck.

**Reviewer action:** check every strict diagnosis against *what EI can
know*, persisted match/wake lineage, source revision/tenant ownership,
truncation, CPU/IO/latency refusal limits and telemetry being non-authorizing.
Approve only the **bounded SDK contract**; no real third-party provider
completeness, provider-host end-to-end SLO or arbitrary production claim.

### 3. `semantic-triage` — evidence collected, status BLOCKED

**Observed on PG16:** the [CI PG16 job](https://github.com/sarooo17/event-intelligence/actions/runs/41737399386)
passed `real PostgreSQL two independent pools atomically enforce trigger
+ batch call/token/cost caps across restart and tenant`, `real Pattern v2
semantic evaluator uses stable per-batch PG receipts when opted in`,
`v1 timeout: unknown remote charge cannot free trigger or batch admission
across workers`, fail-closed malformed budget counters, and same-epoch
reservation refusal. The full Node suite includes the 40-example
public issue-title redacted priority-proxy corpus with explicit
false-positive/false-negative and **hypothetical** cost comparisons.
Existing reviewed [PR #330](https://github.com/sarooo17/event-intelligence/pull/330)
and [PR #374](https://github.com/sarooo17/event-intelligence/pull/374)
support the bounded contract and separate real OpenAI
`14 input + 11 output` **provider-reported usage** witness.

**Reviewer action:** confirm evaluator remains optional, deterministic
prefilter precedes model calls, scope+evaluator+revision+TTL caches do
not cross tenants, PG reservations apply BEFORE provider calls under
concurrent workers, unknown remote outcome retains conservative maximum
and is not refunded/retried in the same epoch. **No** actual OpenAI
invoice reconciliation or remote stop-billing guarantee; those remain
[#376 E49-A/B](https://github.com/sarooo17/event-intelligence/issues/376).

### 4. `downstream-pin-policy` — release-owner decision collected, status BLOCKED

**Observed source policy:** [`docs/EI-RELEASE-COMPATIBILITY.md`](../EI-RELEASE-COMPATIBILITY.md)
and [#41 product-owner scope decisions](https://github.com/sarooo17/event-intelligence/issues/41)
explicitly require all consumer upgrades to be **owner-driven**, with
exact dependency+lockfile pins and independent host CI/rollout.
[PR #410](https://github.com/sarooo17/event-intelligence/pull/410)
changed EI's own source package/lock/Registry metadata only; it did
**not** update Muffin, Artemis or their deployed artifacts.
The manually confirmed previous npm `next` publication did not
implicitly move pinned consumers.

**Reviewer/owner action:** explicitly approve this policy for the frozen
stable candidate: no automatic consumer dependency updates, no direct
Muffin/Artemis PR merge, no deployment, no dynamic `latest` consumption.
Do **not** claim actual current Muffin/Artemis deployment pins were
independently re-verified by this source review.

## Other five mandatory rows (not silently satisfied)

| Gate | Exact-source lead | What still needs independent release-specific review |
| --- | --- | --- |
| `security-revocation-and-tenant` | [Security Scan](https://github.com/sarooo17/event-intelligence/actions/runs/41737399685), [PG16 owner/revoke tests](https://github.com/sarooo17/event-intelligence/actions/runs/41737399386), [#45](https://github.com/sarooo17/event-intelligence/issues/45) | Threat-model inspection of host-owned authorization, tenant/owner and strict session epochs, including negative effect boundaries |
| `pg-retention-audit` | [PG16 real no-prune/corrupt-prefix tests](https://github.com/sarooo17/event-intelligence/actions/runs/41737399386), [#378](https://github.com/sarooo17/event-intelligence/pull/378), [#407](https://github.com/sarooo17/event-intelligence/pull/407) | Confirm audit/dedup/receipt replay and explicit **unbounded storage growth** / operator backup responsibility |
| `pg-chaos-recovery` | [OS recovery](https://github.com/sarooo17/event-intelligence/actions/runs/41737399551), [post-host-effect SIGKILL](https://github.com/sarooo17/event-intelligence/actions/runs/41737399361) | Distinguish at-most-once host effect IDs, retained receipt vs ambiguous result; independently review evidence and negative paths |
| `stored-state-upgrade` | [PG16 logical restore tests](https://github.com/sarooo17/event-intelligence/actions/runs/41737399386), [compatibility matrix](1.0.0-compatibility.md) | Full-store operator backup/clone/refusal and replay exercise; no partial source-only archive masquerading as whole store restore |
| `packed-v1-and-breaking-notes` | [1.0.0 compatibility matrix](1.0.0-compatibility.md), [release notes](v1.0.0.md), [clean-room](https://github.com/sarooo17/event-intelligence/actions/runs/41737399153) | Owner verifies complete breaking/migration disclosure, artifact parity and exact final source; **not** an npm publish |

## Source-freeze and manual signoff procedure (no fabricated approvals)

1. Finalize **all** source/test/docs changes first. This document is
   an evidence index, not itself a release approval. After its review/merge,
   choose the **actual final main commit SHA** as the source candidate.
2. Independently reproduce/inspect each gate's identified test and
   limitations against that exact source. Record real
   `verification.reviewer`, ISO date, precise procedure, immutable
   `verification.sourceCommitSha` and source-bound evidence URL.
   A green automated test, Codex code-review receipt or this worksheet
   is **not by itself** a manual release-owner attestation.
3. In a **separate ledger-only PR** change only the approved rows from
   `blocked` to `verified`. Keep remaining required and optional
   rows blocked. GitHub review must confirm the named approval
   and that the reviewed source SHA is an ancestor with no non-ledger
   file changes. Do not invent a reviewer or silently backdate approval.
4. `node scripts/evidence/v1-release-readiness.mjs --strict`
   MUST remain blocked until all 9 required criteria pass. A source
   package declaring `1.0.0`, even with 8/8 green PR CI, is still
   **NOT PUBLISHED** and not automatically eligible for npm `latest`.
   Stable npm and MCP Registry publishing require separate, explicit
   manual authorization through their existing fail-closed workflows.

The optional enterprise #317/#376 findings, independent security assessment,
provider-billed spend, production HA/RPO/RTO, WORM and E47-C 10k/100k
are NOT hidden prerequisites for the generic SDK v1, but may not be
advertised as certified.
