# Explicit npm release authorization

Issue [#50](https://github.com/sarooo17/event-intelligence/issues/50).

Publishing `mcp-event-intelligence` to npm is now **manual-only**, even
when `package.json` changes on `main`, a test command changes, or a tag
is pushed. The `Publish npm` workflow supports one entrypoint:

1. Open GitHub Actions → `Publish npm` → `Run workflow`.
2. Select **main** and supply exact confirmation `publish`.
3. The job rejects every other event/ref/input combination before
   installing dependencies, packing, or publishing.
4. Existing checks remain mandatory: manifest consistency, `npm run check`,
   `npm run pack:check`, and registry existence check.
5. If the version already exists in npm, publish step remains skipped,
   preserving npm version immutability.

**Why fail instead of skip?** The existing `Release` workflow listens for a
successful completion of `Publish npm`. A skipped job can appear successful
and must not accidentally trigger a follow-on GitHub/MCP registry release.
Invalid operator input causes a failed job.

This is a *control-plane gate*, not automatic validation of semver intent,
source-to-tag compatibility or production readiness; owners must review
those separately. Never publish a version merely to make a fork's CI green.

## Stable v1.0.0 manual evidence fence (#41)

For any stable major version >=1, the manually dispatched `Publish npm`
workflow fails closed **before any npm publication** unless the nine required
SDK gates in `docs/releases/v1-readiness.json` satisfy the strict exact-source
review check. The checker receives the real checked-out commit, requires every
approved gate to pin its earlier reviewed source commit, verifies Git ancestry
and refuses **any changed file outside the readiness ledger** since approval.
The source already reviewed must include exact package/lock/Registry identity,
compatibility notes, frozen release workflows, tests and ABI. After that,
only a ledger-only signoff PR may be merged without invalidating approvals.

The canonical npm version is parsed **before channel selection**, rejecting
SemVer build metadata (including deceptive `1.0.0+build-foo`), malformed
aliases and leading-zero versions. The present nine-gate dossier only
covers the initial **exact `1.0.0`** stable publication: future stable
`1.0.1`/`1.1.0`/`2.0.0` are explicitly blocked until a separate revised
release-readiness policy is reviewed, rather than inheriting v1.0 approval.

The separate `Release` workflow now starts exclusively after a successful
`Publish npm` workflow on `main` (no push-based release of workflow edits).
It repeats the strict source gate before creating any stable MCP Registry
entry, tag or GitHub Release. A manual stable publish that finds an existing
version fails rather than reporting a successful no-op that could trigger a
secondary release workflow. Prereleases remain on `next` and do not meet
this stable requirement. Current `0.12.0-next.1` remains unchanged.

The [nine-gate review dossier](releases/v1-review-dossier.md) lists reusable
implementation evidence and missing exact-v1 approvals. Neither the dossier,
a green unit test, nor the presence of evidence URLs authorizes publication.

## Safe npm tags

The manually confirmed publish job selects `--tag next` whenever the
package semver contains a prerelease identifier (`-next.0`, `-rc.1`, etc).
Only stable semver versions can select `--tag latest`. This prevents an
integration candidate from changing what unsuspecting users install with
`npm install mcp-event-intelligence`. The npm registry existence check
still prevents overwriting an already published version.

## npm prerelease vs. stable MCP Registry

The official MCP Registry publisher does **not** currently accept a
prerelease string like `0.12.0-next.1` in `server.json`. Consequently a
candidate may be published to **npm next** but may not claim MCP Registry
compatibility or create a stable GitHub release. `MCP Launch Check` still
tests stdio and the actual packed npm artifact and checks full release
identity; only the unsupported remote Registry semantic validator is
suppressed for a prerelease version.

`Release` classifies the completed npm publish by semver. On prerelease
versions, **all** MCP Registry and stable GitHub release steps are skipped.
Stable versions retain every remote validation and publication gate.
The npm publisher still uses the configured Trusted Publishing workflow,
requiring `main`, the exact `publish` confirmation and an additionally
supplied `expected_version` equal to the checked-out package version.
