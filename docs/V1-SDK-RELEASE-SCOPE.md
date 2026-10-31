# Event Intelligence v1.0 scope: SDK correctness versus deployed-system certification

Decision authorized by the product owner on 2026-10-31 (#41), superseding
the 2026-10-30 unconditional external-evidence release requirement.
The product is a **runtime-neutral, opt-in SDK**. Its public guarantees must
be implementable and testable without a specific provider, deployment or
agent runtime. No external service's unverified assurances become EI claims.

## A. Required for the generic SDK stable-v1 release

- Functional contract/API/packaged consumption; opt-in providers/hosts and
  typed, versioned protocol; a clean-room packed-consumer test.
- Fail-closed authorization/owner/tenant/revocation reference hooks and
  safe shared-store authority epochs. The host owns identity, approvals,
  OAuth, side effects and final effect permissions; EI must never claim
  otherwise. Mandatory checks do not equate to live-host certification.
- Actual PostgreSQL16 recovery/idempotency/worker concurrency and
  rollback-safe state version/reset; **safe durable retention** preserving
  event and audit provenance, replay/dedup floor and active wake receipts.
  Partial terminal-duplicate compaction alone cannot close a missing
  retention-lifecycle criterion. #47 remains open pending its SDK slice.
- #48: versioned bounded causal inspection; correctly distinguish known
  lifecycle/wake/gap/budget states; return **unknown** when source finality
  is not proven; accept terminal selected-candidate impossibility only
  upon an authenticated, scoped, revision-current, host-verified
  event-time completeness contract. Actual signed test-source + PG16
  negative tests (#375) are SDK conformance; a *third-party provider*
  finality certificate is **not** universally required.
- #48: strict resource budgets, stable output and measured inspector
  CPU/latency under actual high-cardinality PG16 test conditions (#371).
  A universal multi-tenant live-host p99 SLA is not part of EI's generic
  SDK contract.
- #49: optional host-provided evaluator, bounded semantic evaluations,
  cross-tenant cache fencing, deterministic prefilters and durable
  per-trigger/batch max calls, token and worst-case **host estimated cost**
  reservations, deadlines/unknown outcome/no unsafe replay.
  Real 14+11 OpenAI token-usage witness and PG16 two-pool adverse tests
  (#374) support bounded SDK conformance. These are **not** a provider
  invoice or guarantee of a remote cancellation stopping financial spend.
- Clear documentation of limits, v1 public API/incompatibilities,
  manual package release and pinned downstream consumers.

All **nine required** readiness rows remain blocked until release-specific
manual verification references, date and procedure are recorded.
A completed implementation issue does not automatically make the ledger
`verified`. No automatic merge/publish/tag/consumer update is authorized.

## B. Integration conformance (recommended reference evidence)

A first-party producer/consumer may operate in separate services/processes
and independent databases to prove E2E contracts, hostile event replay,
durability, source-log oracle, identity fencing and multiagent/multitenant
behavior. This **can be built and tested by EI maintainers**; requiring an
outside company to author the fixture provides no intrinsic correctness
benefit. Do not call EI-maintainer-controlled services an independently
audited production host.

Any actual source event-time completeness guarantee belongs to the
provider's contract. If it lacks that guarantee, `unknown` is the safe,
specified EI result. A provider signature proves authenticity of its
assertion, not that its underlying history was complete.

## C. Optional production/enterprise validation (#376 and #317)

- Independent external producer/source-business-truth attestation and
  end-to-end provider finality campaign;
- Settled provider billing, per-project cost reconciliation, remote
  cancellation/stop-billing guarantees;
- Independently operated host deployment and separate human security
  assessment of host OAuth, approvals, policy, tenant limits and revocation;
- PostgreSQL primary failover RPO/RTO, off-host/WORM archives, 1k/10k/100k
  production representative sustained fault/steady/burst load, real
  external host/provider p95/p99 and end-to-end DB CPU/IO attribution.

These remain **open and unverified**, not silently waived, in #376 and #317.
They are requirements only when claiming a particular deployment,
enterprise certification or production SLA—not when shipping the generic
SDK, unless a future owner decision explicitly changes its release policy.

## Workstream closure and test truth

The owner can approve a narrower SDK acceptance scope explicitly in the
issue. Link reviewed/merged PRs, exact commit SHA, CI, evidence limits,
and the transferred #376 target. Never mark an unrun provider/host test
as passed, or close #47 while SDK retention/recovery correctness remains
unchecked. Never downgrade a required security/retention feature by
simply relabeling its missing implementation as "production".

The 2026-10-31 scope decision affects requirements, **not** the strength
or outcomes of real observed tests. This is a release/acceptance-policy
change, not an assertion that production certification already exists.
