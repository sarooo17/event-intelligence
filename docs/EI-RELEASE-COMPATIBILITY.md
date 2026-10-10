# EI pre-1.0 releases, state safety and consumer-owned upgrades (proposal)

> Proposed for [#50](https://github.com/sarooo17/event-intelligence/issues/50) and umbrella [#41](https://github.com/sarooo17/event-intelligence/issues/41). **Not a current compatibility guarantee.** Existing v0.11 implementation and consumer integration remain authoritative until this policy and its tests are implemented.

## Why three kinds of version matter

1. **npm package version** controls the code installed by a host (`mcp-event-intelligence@0.11.0`, `0.12.0`, etc.).
2. **Event/Pattern/protocol versions** govern the incoming MCP Events draft, the canonical Pattern wire schema and public control/activation shapes.
3. **Persisted-state/store schema versions** govern what code can read, write, migrate or roll back against the same durable database.

Upgrading one is not the same as upgrading the others. **Publishing a package is not a deployment.** Even a consumer whose package is pinned can encounter compatibility issues if it shares a database schema or remote provider changes its event protocol; include these surfaces in upgrade tests.

## Confirmed consumer pin at roadmap creation

Following merged [Muffin PR #851](https://github.com/muffin-project/muffin-agent/pull/851), upstream `muffin-project/muffin-agent` **dev** declares exactly:

```json
"mcp-event-intelligence": "0.11.0"
```

`package-lock.json` also records the 0.11.0 resolution. Ordinary `npm ci` installs locked dependencies; publishing EI 0.12 or 1.0 does **not** bump Muffin. The Muffin deployment will still require its own explicit PR/update, CI and rollout.

For comparison, a consumer declaring `^0.11.0` could select compatible **0.11.x** patch versions during a fresh resolve; `^0.11.0` does not accept 0.12.0 because pre-1.0 caret ranges are minor-bounded. Exact pins plus lockfiles are preferable for deterministic shared-runtime integration.

**Do not infer** the deployed Muffin build or deployment environment from the upstream dev branch alone. An actual rollout must inspect that environment's commit, lockfile and dependency artifact.

## Decided policy: clean breaks are allowed before v1.0

- **Do not maintain compatibility code only to keep Muffin, Artemis or an older host working.** Old function names, adapter facades, schemas and deprecated exports can be deleted/refactored when the new canonical contract is better. No mandatory deprecation period while the package is pre-1.0. Document breaking changes and test the **new** API thoroughly.
- Publishing a new version never rewrites an external host's `package.json`, lockfile, images, production DB or code. Consumers with exact version pins stay on their old installed code until they deliberately update.
- **Consumer upgrades are owner-driven.** Muffin/Artemis integration changes, CI, E2E, deployment and upgrade timing are not EI package PR or publish blockers. No EI-side compatibility adapters for those hosts.
- No auto-generated dependency-update PR is merged silently, and no consumer should load `latest` dynamically in production.
- Runtime target/authority, credentials, MCP transport and tool discovery remain host-owned.
- **Persistence is separate from API backward compatibility.** Old event stores/wake receipts may be incompatible: choose a deliberate, tested migration *or* fail-closed upgrade with documented backup/export-and-reset/restore procedure. Never silently erase live triggers or pretend an unsupported old schema is valid.
- Existing event payloads are untrusted and never become a new authorization credential after a version change.
- Storage format changes require explicit schema identification and evidence; a package pin cannot protect a *shared* live database if another worker has migrated it.
- Experimental MCP Events profiles may be superseded without maintaining all old protocol handlers, provided unsupported versions fail explicitly; do not confuse this with consumer API legacy shims.
- Release notes distinguish public API, provider/wire, persisted state and compatibility choices.

## Proposed upgrade compatibility matrix

| Scenario | Minimum test | Expected treatment |
| --- | --- | --- |
| Pinned v0.11 consumer after v0.12 publication | Reinstall existing lock with `npm ci` | Same v0.11 installed, no implicit upgrade |
| Old consumer + candidate library | No EI release gate for this combination | Owner updates consumer when ready; breaking old API is permitted pre-1.0 |
| Updated clean-room host + candidate library | Build/typecheck, current host conformance, trigger lifecycle | Must pass as EI library acceptance |
| Existing durable state + candidate store code | Version check, migration only when supported, or snapshot/reset rehearsal | Never silently reinterpret/erase data; clean failure if incompatible |
| Mixed EI worker versions against same DB | Schema version check and isolation | Reject unsupported concurrent versions; mixed-version support not required |
| Candidate downgrade/rollback | Snapshot/restore or declared forward-only upgrade | Explicit procedures; never promise transparent downgrade |
| MCP Events extension draft changes | Per-profile contract and provider conformance tests | Unsupported profile refused/disabled explicitly |
| Provider removed/revoked | Attach/detach and persisted subscriptions | No unauthorized future poll/wake; reversible recovery policy documented |
| Semantic adapter changed | Cache invalidation keyed by evaluator/version/context | No stale cross-model/cross-tenant reuse |

## Proposed publish process

1. Tag/commit the exact candidate and freeze code for the release checks.
2. Build, typecheck, run unit/regression, Pattern property/conformance, host/management conformance, HA PostgreSQL suite, security suite and audit checks.
3. `npm pack` and consume the **tarball** in a clean project, verifying **current** exports and types; no release requirement to load old, removed APIs.
4. Check storage version on startup and test either supported migration or safe fail-closed backup/reset/restore procedure. Unsupported mixed-version workers must be rejected, not supported artificially.
5. Run current host conformance using independent host-shaped fixtures. Do **not** make EI release depend on Muffin/Artemis branch tests: their maintainer updates and validates those consumers separately when desired.
6. Produce benchmark and fault-injection report if runtime/store/matcher changed; detect regression against archived release baselines.
7. Review dependencies/SBOM/license/security; verify version-specific policy and disclosure path.
8. Publish release notes with exact package version, protocol compatibility profile, Pattern schema version, store-schema version, removed APIs/breaking changes, migration **or deliberate reset** instructions, known limitations and security fixes.
9. Publish npm only after complete release gates; then confirm npm package hash, exports and registry metadata.
10. Monitor published artifacts and consumer signals; any defect triggers an explicit hotfix release, not mutation of an already-published npm version.

## Optional consumer-owned upgrade checklist (not an EI release gate)

When the host maintainer later chooses to upgrade Muffin, Artemis or another consumer:

- [ ] Identify currently deployed ref and installed EI artifact, not only package declaration.
- [ ] Review EI diff/changelog and any changed public schemas, behavior, store compatibility and MCP draft assumptions.
- [ ] Prepare separate dependency + lockfile PR with exact version and DCO/review policy where applicable.
- [ ] Update consumer integration code to the **new canonical API**, then run compile/build, host conformance and trust/approval/wake/restart tests. Do not request a library shim for the old integration.
- [ ] Run E2E with synthetic Events-capable provider and actual host continuation path; if possible test in isolated staging with real source credentials.
- [ ] Determine whether old persistent triggers and receipts can be migrated or require a **deliberate backup/reset** before restart; never expect silent preservation.
- [ ] Test rollback (or commit to upgrade-only and backup/restore) before deploying.
- [ ] Merge and deploy by host owner; no vendor-specific release hook in EI publishes a consumer upgrade.

## Versioning and support decisions still to be made

Before 1.0 freeze:
- SemVer contract for stable v1 public exports; before v1.0, intentional breaking changes and removal of old APIs are allowed without deprecation shims.
- Source/draft MCP Events extension profiles supported, and expected compatibility windows.
- Persisted-store schema version identification and the documented choice per upgrade: forward migration, or fail-closed with backup/reset; no general legacy reader requirement.
- Node / PostgreSQL / official MCP SDK version support policy and CI matrix.
- Signed releases, provenance/SBOM and vulnerability disclosure SLA.
- Definition of who can authorize a consumer upgrade and who owns store rollout/backup.

Record decisions as ADRs or updates to this policy; no implicit assumptions.

## Release block conditions

Do not claim production-ready 1.0 if incompatible DB transitions are unrecognized or silently destructive, there are unresolved critical/high security findings, uncontrolled cross-tenant visibility, untested **current** host receipt semantics, broken packed npm exports or falsely advertised official MCP Events conformance. An intentional, documented breaking API is not itself a release blocker. A limitation may be explicitly documented for lower-risk deployments, but it cannot be renamed as a passed test.

## Non-goals

- Runtime-specific install hooks, `toMuffin()` or `toChatGPT()` in the EI package; deprecated compatibility code retained solely for older hosts.
- Automatically installing/reloading the new package in a running host.
- Replacing the host's OAuth/session, policy/approval, durable Turn/Work or CI/CD process.

## Automated release identity gate (incremental implementation)

The pure `scripts/check-release-manifest.mjs` release gate compares package
identity/version across `package.json`, the root and `packages[""]` entries
in `package-lock.json`, and the MCP Registry entry in `server.json`.
CI runs it before tests and the npm publish workflow runs it before its release
verification. A mismatch exits nonzero with
`EI_RELEASE_MANIFEST_MISMATCH`. Negative tests mutate every relevant field
independently to prove the gate detects skew.

This ensures metadata *consistency only*. It does not prove a safe database
migration, protocol conformance, vulnerability review or v1.0 readiness. It
does not bump `package.json`, publish an npm version, tag a release, or update
Muffin/Artemis. The release policy and #50 remain open.
