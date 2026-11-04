# Stable v1.0.0 — source-pinned technical gate-evidence audit (2026-11-04)

**Purpose:** reproducible **technical evidence inventory for #41**, not a release
approval. The candidate was prepared and independently code-reviewed in
[PR #410](https://github.com/sarooo17/event-intelligence/pull/410);
reviewed PR HEAD `4284f356235269bda9c3d8cf0e7ef7d1da780b8a`,
merged source `4b6200c15e91af8efcb62020f329364d8a49ea78`.
All eight exact-PR-HEAD workflows were green. The source-frozen SHA for
**release attestations must be the subsequent reviewed main ancestor**, not
a self-referential SHA in this document. This inventory was authored by an
AI development assistant; **it is not an independent human security audit,
a reviewer signature or an operator approval**.

The review must distinguish *actual passed tests* from a production/deployment
claim. Only nine required **SDK** gates are eligible for stable release
consideration. All six optional production/enterprise categories remain
blocked and untouched; #317 and #376 are not covered here.

## Exact candidate evidence runs, not inferred outcomes

- [#410 CI — run 41737399386](https://github.com/sarooo17/event-intelligence/actions/runs/41737399386):
  exact candidate `npm run check`, source and compatibility contract checks
  **PASS**; actual PostgreSQL16 service **139 tests / 139 pass** in
  `postgres-ha`, including 2 independent PG pools for semantic budgets,
  session authority, source retention, audit corruption and host-receipt
  replay. `pg-os-matched-contenders` job was **skipped**, not counted.
- [#410 Clean-room Smoke — run 41737399153](https://github.com/sarooo17/event-intelligence/actions/runs/41737399153):
  actual `mcp-event-intelligence-1.0.0.tgz` installed via `npm install` in
  isolated consumers; packed simple-trigger, headless restart, typed TS,
  managed-host contract denial, multiple host targets and MCP stdio process
  readiness **PASS**. These are EI-owned **external-process consumers**, not
  independently maintained third-party hosts.
- [#410 Public Release Check — run 41737399176](https://github.com/sarooo17/event-intelligence/actions/runs/41737399176):
  source SHA check, version-specific compatibility doc, 156/156 non-PG
  boundary tests, 25/25 PG security evidence tests, `npm pack`, **12 public
  export paths parity** and Docker build **PASS**. PG `pg_dump + pg_restore`
  recovers trigger, audit chain, wake receipt and replay fence on a test DB.
  The CI did **not** run the full-suite `if: push` step on PR; the general
  CI workflow independently did run `npm run check`.
- [#410 PostgreSQL OS crash soak — run 41737399551](https://github.com/sarooo17/event-intelligence/actions/runs/41737399551):
  `status=completed`, **3 real kill/recovery rounds** recorded.
- [#410 post-host-effect SIGKILL — run 41737399361](https://github.com/sarooo17/event-intelligence/actions/runs/41737399361):
  real OS `SIGKILL` **after** a durable host effect and **before** EI
  receipt persistence, then replay/claim reconciliation; **exactly one host
  effect per wake** on isolated PostgreSQL16; raw JSON artifact uploaded.
- [#410 Railway PostgreSQL smoke — run 41737399583](https://github.com/sarooo17/event-intelligence/actions/runs/41737399583):
  actual `test/railway-validation.test.mjs` **PASS**, not a claimed physical
  primary failover or enterprise-host benchmark.
- [#410 Security Scan — run 41737399685](https://github.com/sarooo17/event-intelligence/actions/runs/41737399685):
  Gitleaks **PASS**, not an independent threat-model audit.
- [#410 MCP Launch Check — run 41737399426](https://github.com/sarooo17/event-intelligence/actions/runs/41737399426):
  **PASS** on exact candidate.

The **independent code review** on [#410, exact HEAD 4284f35623](https://github.com/sarooo17/event-intelligence/pull/410#issuecomment-6617913284)
reported no further major issues after correcting an obsolete negative
compatibility-test constant. Earlier [#407](https://github.com/sarooo17/event-intelligence/pull/407)
reviewed the indexed PostgreSQL audit-head append and had 12/12 workflows green.
An AI code review is **not**, by itself, a gate-specific owner attestation.

## Candidate required gates and review procedures

| Gate | Direct evidence / candidate reviewer procedure | Explicit boundary |
| --- | --- | --- |
| `host-contract-and-package` | Check 12 packed npm exports/types against `package.json#exports`, root/lock/server version parity, isolated packed TypeScript + headless + managed/multi-target samples and `event-intelligence.host-conformance.v3`; #410 clean-room and Public Release Check | Host's actual OAuth, authz, receipts and third-party integration still owner-operated |
| `packed-v1-and-breaking-notes` | Read [1.0.0 compatibility matrix](1.0.0-compatibility.md), [notes](v1.0.0.md), CHANGELOG, `server.json` and public export checker. Verify deliberate `authorize()`/void receipt/confirmation removals, exact trigger/Pattern/store marker version, fail-closed backup/reset, and packed tarball on #410 | Tarball is **not** in npm yet; operator approval/9-of-9 strict gate required |
| `full-explainability` | Inspect scoped [#48](https://github.com/sarooo17/event-intelligence/issues/48) 5/5, source-frontier strict/unknown/gap tests, and [#391](https://github.com/sarooo17/event-intelligence/pull/391) independent replay of 900 full PG16 inspector samples at 1k/10k/100k candidate tiers. #410 PG16 `postgres-inspector-keyed-read`, persisted gap and strict window tests passed. Check fidelity failures rather than treating unknown as candidate impossible | 1k/10k/100k here means **Inspector candidate tiers**, not 1k/10k/100k sustained EI event throughput. No external truth/production SLO certification |
| `semantic-triage` | Inspect scoped [#49](https://github.com/sarooo17/event-intelligence/issues/49) 5/5, [#374](https://github.com/sarooo17/event-intelligence/pull/374) two-pool bounded admission + failed/unknown outcomes, and #410 PG16 real `postgres-semantic-admission` (cross-tenant, restart, call/token/host-reserved estimated-cost limits, malformed provider totals). Confirm no model is needed for deterministic patterns and semantic decisions grant no authority | **Host-reserved estimated** cost is not provider invoice; client timeout/AbortSignal does not establish provider stop-billing |
| `downstream-pin-policy` | Review [#41](https://github.com/sarooo17/event-intelligence/issues/41) owner-approved no-auto-consumer decision and [compatibility/upgrade policy](../EI-RELEASE-COMPATIBILITY.md), plus [#277](https://github.com/sarooo17/event-intelligence/pull/277), [#280](https://github.com/sarooo17/event-intelligence/pull/280). Source release and manual npm pipeline never mutate Muffin/Artemis consumers. Release owner must **affirm** continue exact-pinned downstream upgrades separately. | Does **not** certify which Muffin/Artemis version is actually deployed; no auto-PR/upgrade |
| `pg-retention-audit` | Inspect [#378](https://github.com/sarooo17/event-intelligence/pull/378) full no-prune operator contract, [#407](https://github.com/sarooo17/event-intelligence/pull/407) indexed canonical audit-head and #410 PG16 no-prune tests **118–120**, terminal duplicate compaction and audit proof verification with tampered predecessor | Source/dedup/audit/wake proofs grow without bound; no destructive physical retention, independent WORM archive or RPO/RTO certification; capacity/backup ownership is operator responsibility |
| `pg-chaos-recovery` | Review #410 real SIGKILL before/after host-effect, post-host receipt recheck, 3 OS crash/recovery rounds and actual PG16 replay, match and wake receipt tests. Evidence links above. Check that a failed unknown host outcome is **not** mistaken for no remote effect. | A crashed **worker** is not PostgreSQL primary failover; no production-cluster RPO/RTO or independent host effect certification |
| `security-revocation-and-tenant` | #410 156 non-PG + 25 PG security tests, [#45](https://github.com/sarooo17/event-intelligence/issues/45), exact-source `docs/SECURITY-THREAT-MODEL-V1.md`; verify EI-side revoke-before-append, epoch/owner fences and tenant denial, **separating host's final authorization**. | A dedicated human independent external deployed-host security assessment is **optional #317**. Gate-specific SDK review/approval still needed, not declared here |
| `stored-state-upgrade` | #410 PG16 `pg_dump + pg_restore` test preserved trigger, chain, host receipt and replay fence, and source compatibility matrix spells out stop-workers/backups/reset/replay; reviewer must still establish **complete end-to-end operator procedure** for unsupported old markers, full DB clone/recovery and concurrent rollback safety | A passing isolated test is not proof of an operator-restored real deployment; leave blocked if full procedure/signoff incomplete |

## Signoff provenance and staged release safety

**Freeze source after this evidence inventory and all tests are reviewed.**
The final release-reviewed ancestor must be a **real merged main commit**.
A **later ledger-only PR** may add `verification.reviewer` (the actual
reviewer, including its actual AI/human identity; **never invent a person**),
`date`, `procedure`, `sourceCommitSha` and exact immutable evidence links
only for gates genuinely reviewed. If a signoff is machine-assisted, say so;
do **not** call it independent human approval. Ask a separately running reviewer
to independently scrutinize each proposed criterion and mark any unsupported
one `blocked`.

`node scripts/evidence/v1-release-readiness.mjs --review-attestations`
checks per-row evidence shape, the reviewed main ancestor and **zero
source changes except the ledger** after that ancestor, including a partially
signed 5/9 or 7/9 ledger. This is a **non-publishing** CI check. The existing
`--strict` remains blocked until all 9/9 required criteria are genuinely
verified, and subsequent publishing always requires separate explicit
operator action. Merely obtaining a green PR, a reviewer emoji or a synthetic
test does not turn an unsupported requirement green.
