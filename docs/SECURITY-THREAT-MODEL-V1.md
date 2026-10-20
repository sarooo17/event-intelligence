# Security authority and threat model v1 — partial issue #45

The source-of-truth matrix is `docs/security-threat-model-v1.json`.
It covers twelve explicit boundaries from MCP transport ingress to release
publishing. Each row identifies:

- the **authority owner** (host, EI, operator, or shared);
- one concrete attacker hypothesis;
- the **existing test file** offering partial negative evidence;
- the **remaining unverified protection**.

The test `test/security-threat-boundary-matrix.test.mjs` enforces
completeness, test-file references and public residual-risk declarations.
It cannot replace an independent security review or demonstrate that a
test actually addresses every hypothesized attack. No row is marked
"certified", and `securitySignoff` remains
`pending-independent-review`.

Important distinctions:

* **MCP producer credentials, OAuth, transport byte/time limits, host
  approval, runtime principal capabilities and final external effect
  authorization are host-owned**, not Event Intelligence functions.
* EI rejects unsafe decoded event objects, fences known stale sessions,
  provides trigger-owner store scopes, and maintains matching/wake receipts,
  but a revocation cannot un-send an already delivered external effect.
* A durable EI wake receipt does **not** guarantee a host-side financial,
  network or UI action executes exactly once; hosts must implement durable
  idempotency keys and retry-safe side effects.
* Reference-only event lineage never upgrades untrusted provider payloads
  into authority. The host must reauthorize work after the agent wakes.
* Exact cross-worker revocation races, queued activation cancellation,
  multi-tenant fuzzing, operator retention/audit export, large body/rate
  quotas and independent review still need evidence.
* **Unsolved final authorization snapshot race (#235):** a trigger owner transfer
  can commit AFTER the guard's last owner query snapshots its result but
  BEFORE the old principal receives a hydrated wake response. PR #232 tests
  only transfers committed before this final snapshot; that is a partial
  negative regression, **not** an atomic revocation guarantee.

Use this matrix with the v1 readiness ledger before publishing. Never
place exploit reproductions, secrets or private vulnerability details in
public issues; follow `SECURITY.md` private reporting process.

**Compatibility:** documentation and a test verifying evidence inventory;
no runtime behavior changes, no additional OAuth/provider policy code,
no new security guarantee and no npm publication.
