# v1.0 evidence ledger and release eligibility (issue #50)

The checked-in `docs/releases/v1-readiness.json` is the explicit list
of **nine mandatory SDK correctness criteria** and **six optional
production/integration certification criteria**. Optional means not a
prerequisite to publishing the generic SDK, **not** verified or unnecessary.
The explicit 2026-10-31 product-owner scope correction (#41) keeps both
**#48 explainability and #49 optional-at-runtime semantics mandatory as
bounded SDK contracts**. Their external provider truth/billing obligations
are tracked under the **optional operational validation #376** instead.
#45 mandatory security is SDK authorization/fail-closed reference behavior;
#317 human-operated external-host security certification is separate and
optional for the generic SDK. Real PostgreSQL16 correctness and defensible
retention/recovery remain mandatory. Every row maps to its numbered issue.
Every row must remain `blocked` **until** release-specific evidence is reviewed
and a named, source-pinned attestation is merged; an implementation issue
marked completed never auto-verifies a ledger row.

**Status as of 2026-11-06 (last signed SDK baseline):** The nine **required
SDK v1.0 readiness gates were all marked `verified`** in the ledger-only,
reviewed/green [PR #419](https://github.com/sarooo17/event-intelligence/pull/419).
The frozen reviewed source ancestor was
`f6923e87ba1744091b13bae30008c8a0b38c03cb`; the ledger-only merge on
`main` was `0332ef7cb3943b74468f12f25cb49c9c6a4b6407`.
The reviewer is explicitly **ChatGPT GPT-6 under owner delegation, not an
independent human auditor or deployed-host security certification**.
The SDK implementation workstreams #42–#50 and scoped #269 are closed.
The **6 optional production/enterprise categories remain blocked**;
[#376](https://github.com/sarooo17/event-intelligence/issues/376) has 2/10
acceptances (E48-A/B) and [#317](https://github.com/sarooo17/event-intelligence/issues/317)
has 0/5. Neither is a missing generic SDK feature or an implicit
production certification.

**This repository documentation update itself changes the source-frozen tree.**
The historical 9/9 attestation cannot simply be carried into the final
published HEAD: review the complete updated documentation on a freshly
merged `main` source commit, invalidate/re-attest all nine signatures in a
subsequent **ledger-only PR**, and let the strict checker verify ancestry
and zero non-ledger drift. Do not weaken that protection to simplify docs.

The npm UI observed on 2026-11-02 showed `0.12.0-next.1` on `next`
and `0.11.0` on `latest`. This historical distribution observation
is distinct from the **unpublished** source candidate
`mcp-event-intelligence@1.0.0`; neither a 9/9 ledger nor green CI
authorizes its publication. Follow the [roadmap #41](https://github.com/sarooo17/event-intelligence/issues/41)
and [review dossier](releases/v1-review-dossier.md) for reproducible evidence
and the separate explicit owner authorization.

```sh
# Read-only report: expected 9/9 -> eligible-for-manual-review only
# after the source-pinned attestations have been revalidated on main.
node scripts/evidence/v1-release-readiness.mjs --report

# Source-pinned strict preflight (NOT a publish command). Requires all
# nine signed gates, reviewed main ancestor, zero post-review source drift,
# exact checked-out HEAD and canonical 1.0.0 version.
EI_RELEASE_SOURCE_SHA="$(git rev-parse HEAD)" \
  node scripts/evidence/v1-release-readiness.mjs --strict
```

The Public Release Check captures the `--report` JSON as an
artifact for the unpublished candidate; after correct 9/9 signoff the
status may read `eligible-for-manual-review`. It does **not** automatically
publish, tag, merge or update consumer pins; only the separately authorized
operator workflow runs `--strict` before writing to npm. The checker validates the exact criteria set, no duplicates,
current product-owner required/optional classification, status, and manually authored signoff/evidence
metadata for any `verified` row. It does not fetch GitHub live state or
assert an external security review from its own contents: claims are
subject to human/reviewer verification, and `autoPublish` is always false.

Before changing a row to `verified`, the release owner must attach evidence
links, named reviewer, date and explicit verification procedure; PR review
must verify both completeness and truth of those artifacts. For stable v1, a
verified row must also contain an immutable 40-character
`verification.sourceCommitSha` pointing to a **previously reviewed, frozen
main-branch source commit**. The strict publish/release check verifies that
this commit is an ancestor of the actual release HEAD and that the entire
repo, except this readiness ledger, has no changes since the reviewed source.
It is impossible for a committed file to contain its own commit hash; do not
ask the ledger to sign itself. `--strict` also requires
`EI_RELEASE_SOURCE_SHA` set to the actual checked-out HEAD and is blocked
until package identity is exactly `1.0.0`. Workflow runs derive this from
GitHub and recheck the Git commit; neither `--report` nor a user-written
reviewer string is independent evidence. A green
`eligible-for-manual-review` means only all checked-in prerequisites are
declared, not that an npm publish is safe or authorized. Existing exact
Muffin/Artemis dependency pins are never touched by this workflow.

Compatibility: this ledger checker is an internal operator tool, not a runtime/API change, database migration or publication action. Its source/CI report does not itself publish or attest any npm version.
Published 1k/10k/100k isolated PostgreSQL16 benchmarks and crash recovery
tests are SDK engineering evidence, not production claims. Independently
operated host adoption, full real-source finality, provider-billed spend,
production PostgreSQL primary failover RPO/RTO, p99 latency and human security
attestation remain open under #376/#317. **Do not advertise any of these as
certified**, even though the nine generic SDK gates have been verified.

**Scope regression guard:** `test/v1-release-readiness-ledger.test.mjs`
refuses downgrading the nine core SDK requirements (including #48 and #49),
rejects promotion of external certification rows as mandatory without an
explicit policy change, and confirms that optional external reports cannot
bypass core retention/security gates. The checker never auto-publishes.
