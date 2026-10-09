# EI release, state and consumer compatibility policy (proposal)

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

## Invariants for future releases

- Publishing a new version never rewrites an external host's `package.json`, lockfile, images, production DB or code.
- No auto-generated dependency-update PR is merged silently and no consumer loads `latest` dynamically in production.
- Runtime target/authority, credentials, MCP transport and tool discovery remain host-owned.
- Old external wake IDs/receipts and in-flight conditions must either remain recognized by upgraded EI **or** have an explicit, tested incompatible migration/rollout path.
- Existing event payloads are untrusted and never become a new authorization credential after migration.
- Storage format changes require schema policy, transactional migrations and evidence; a package pin cannot protect a *shared* live database if another worker has migrated it.
- Release notes must distinguish API, wire, persisted state and provider compatibility.

## Proposed upgrade compatibility matrix

| Scenario | Minimum test | Expected treatment |
| --- | --- | --- |
| Pinned v0.11 consumer after v0.12 publication | Reinstall existing lock with `npm ci` | Same v0.11 installed, no implicit upgrade |
| Current consumer + candidate library | Build/typecheck, runtime conformance, full trigger lifecycle | Green or explicit required consumer changes |
| Upgraded consumer + candidate library | End-to-end source, create/manage, wake + restart | Must pass before consumer PR merge |
| Existing durable state + candidate store code | Replay, migration rehearsal, lease/recovery | Compatible read/write or explicit migration plan |
| Mixed EI worker versions against same DB | Lease/claims, schema version check, audit ordering | Fail closed if not supported; otherwise proven safe |
| Candidate downgrade/rollback | Restore/recovery test with in-flight wake and trigger | Supported rollback procedure or well-signaled irreversible upgrade |
| MCP Events extension draft changes | Per-profile contract and provider conformance tests | Unsupported profile refused/disabled explicitly |
| Provider removed/revoked | Attach/detach and persisted subscriptions | No unauthorized future poll/wake; reversible recovery policy documented |
| Semantic adapter changed | Cache invalidation keyed by evaluator/version/context | No stale cross-model/cross-tenant reuse |

## Proposed publish process

1. Tag/commit the exact candidate and freeze code for the release checks.
2. Build, typecheck, run unit/regression, Pattern property/conformance, host/management conformance, HA PostgreSQL suite, security suite and audit checks.
3. `npm pack` and consume the **tarball** in a clean project, verifying all exports and types; exercise both fresh install and existing lockfile reinstall.
4. Run migration/restore and (when changed) database mixed-version/rollback test; produce explicit compatibility report.
5. Run opt-in Muffin and Artemis consumer tests on isolated checkout/CI, without pushing dependency changes or altering their main branches. The consumer owner chooses whether to update.
6. Produce benchmark and fault-injection report if runtime/store/matcher changed; detect regression against archived release baselines.
7. Review dependencies/SBOM/license/security; verify version-specific policy and disclosure path.
8. Publish release notes with: exact package version, protocol compatibility profile, Pattern schema version, store-schema version, breaking changes, migration and rollback instructions, known limits and security fixes.
9. Publish npm only after complete release gates; then confirm npm package hash, exports and registry metadata.
10. Monitor published artifacts and consumer signals; any defect triggers an explicit hotfix release, not mutation of an already-published npm version.

## Consumer-owned upgrade checklist

For each host (Muffin, Artemis or independent adopters):

- [ ] Identify currently deployed ref and installed EI artifact, not only package declaration.
- [ ] Review EI diff/changelog and any changed public schemas, behavior, store compatibility and MCP draft assumptions.
- [ ] Prepare separate dependency + lockfile PR with exact version and DCO/review policy where applicable.
- [ ] Run compile/build, host conformance and relevant trust/approval/wake/restart tests.
- [ ] Run E2E with synthetic Events-capable provider and actual host continuation path; if possible test in isolated staging with real source credentials.
- [ ] Validate persisted triggers, owner-scoped watch management and existing wake receipts across restart.
- [ ] Test rollback (or commit to upgrade-only and backup/restore) before deploying.
- [ ] Merge and deploy by host owner; no vendor-specific release hook in EI publishes a consumer upgrade.

## Versioning and support decisions still to be made

Before 1.0 freeze:
- Semantic Versioning policy per supported export path, experimental vs stable API, deprecation period.
- Source/draft MCP Events extension profiles supported, and expected compatibility windows.
- Persisted store version number and which previous versions can be read/migrated.
- Node / PostgreSQL / official MCP SDK version support policy and CI matrix.
- Signed releases, provenance/SBOM and vulnerability disclosure SLA.
- Definition of who can authorize a consumer upgrade and who owns store rollout/backup.

Record decisions as ADRs or updates to this policy; no implicit assumptions.

## Release block conditions

Do not claim production-ready 1.0 if there are unknown incompatible DB transitions, unresolved critical/high security findings, uncontrolled cross-tenant event visibility, untested host receipt semantics, broken packed npm exports or falsely advertised official MCP Events conformance. A limitation may be explicitly documented for lower-risk deployments, but it cannot be renamed as a passed test.

## Non-goals

- Runtime-specific install hooks, `toMuffin()` or `toChatGPT()` in the EI package.
- Automatically installing/reloading the new package in a running host.
- Replacing the host's OAuth/session, policy/approval, durable Turn/Work or CI/CD process.
