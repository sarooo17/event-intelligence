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
* **Final owner authorization snapshot (#235):** the standalone MCP
  `wakeHydrate` and `inspect` tools now perform an additional owner/version
  check AFTER constructing their activation/inspection response and BEFORE
  handing it to the MCP server. A revocation/tenant transfer committed before
  this final query's snapshot fails closed with nondisclosing not-found. This
  protects the asynchronous hydration window that previously followed the
  last check.
* **Still unresolved (#235):** a transfer that commits AFTER the last owner
  query snapshots its result can race the response return. The narrow
  read-consistency contract here treats the final authoritative query snapshot
  as the authorization linearization point: a read already authorized there
  may finish, even if revocation commits before transport delivery. This is
  NOT an atomic cross-worker cancellation mechanism and does not cancel
  queued wake jobs. Real independent-pool PostgreSQL 16 ordering tests now
  cover the FINAL authorization query snapshot under #235; they do NOT
  establish a stronger no-response-after-revocation-commit guarantee.
  Parent #45 and independent security signoff remain open.

Use this matrix with the v1 readiness ledger before publishing. Never
place exploit reproductions, secrets or private vulnerability details in
public issues; follow `SECURITY.md` private reporting process.

**Compatibility:** documentation and a test verifying evidence inventory;
no runtime behavior changes, no additional OAuth/provider policy code,
no new security guarantee and no npm publication.

## Owner read vs owner-transfer order — explicit contract (#235)

The standalone stdio MCP read authority is the **trusted configured owner**
(type, principal ID and tenant ID) compared with the authoritative persisted
owner of the **specific trigger version in the selected store scope**. Model
arguments, events and evidence text never establish identity.

**Linearization point:** for a requested trigger version the *last* successful
owner-filtered `listTriggers({owner})` snapshot, including its persisted
`getTriggerState(triggerId,version)` read. In PostgreSQL 16, that is the
statement snapshot of the authoritative trigger-state SELECT. A successful
read can complete *after* a concurrent transfer has committed **if and only
if** the final authorization snapshot happened **before** that transfer.
This is standard linearizable-read ordering for overlapping read and
revocation operations; it is **not** a promise of retroactive cancellation
of reads already admitted, and not a guarantee that no evidence can ever
arrive after a revocation commit.

A transfer committed **before** the final authorization query must deny
with the same nondisclosing not-found as a missing trigger. A transfer
committed after the query snapshot may allow the already-authorized read
to finish; a *new* read must deny. The initial authorization guards
evidence access and the final authorization guards returned results. A
versionless wake producer is **not** authorized by selecting a newer owned
version; the explicit version-pinning and failed-builder error-redaction
corrections are tracked separately in PR #239 and must merge successfully
before any #45 signoff.

**Independent multi-pool evidence:** real PG16 barrier tests in
`test/postgres-owner-revocation-snapshot.test.mjs` make the final SELECT
capture an old row in pool A, commit owner/tenant transfer through an
independent pool B, then release the SQL result to the MCP guard and prove
the already-authorized inspect and wake reads can finish. A separate
barrier commits first and shows the final query rejects; post-transfer
fresh reads are denied, with no tenant enumeration in error fields.

**Remaining host responsibilities:** token/session revocation, OAuth and
permissions for external effects, and cancellation of already queued
work remain host-owned. EI does not atomically prevent an HTTP/stdio
transport from delivering a response after a later revocation, and
cannot lock owner changes in a separate host authority database. If a
host requires **strict no-result-after-revoke-commit**, it must add a
shared versioned authority/fence coupled to transport delivery; that
stronger contract is *not provided by this standalone owner-read path*.
No cross-worker in-memory locks or invented provider credentials have
been added. Independent review and security release CI remain necessary.

## MCP untrusted occurrence-name mismatch error boundary (#45)

An MCP provider's descriptor and occurrence `name` strings are both provider-
controlled. A mismatch is now rejected with a constant error message and
stable code `MCP_EVENTS_OCCURRENCE_NAME_MISMATCH` rather than echoing either
value into a thrown Error. The focused regression verifies no name/payload
secrets in message, stack or property descriptors and **no** occurrence
append/activation side effects. The dedicated negative case is run in the
Public Release Check security evidence gate, not only an optional test.

**Scope limit:** this does not sanitize arbitrary third-party provider
exceptions, raw transport responses, source-config credentials or host logs;
those remain separate trust boundaries and #45 stays open. This change does
not modify a provider's event compatibility or enable unauthenticated tools.

## Pre-revocation durable append vs detached session (#45)

For a **single** host MCP client manager, detach prevents newly admitted
occurrences, rejects late poll responses and fences further cursor/source
mutations. There is one deliberate linearization rule for an append already
admitted before detach: if `appendMcpOccurrence` durably accepts its event,
the accepted occurrence **must** still be ingested by the EI composite
consumer, even if detach happened while storage was awaiting. Otherwise a
persisted dedup receipt with zero CEP activation could permanently lose that
source occurrence on provider replay. Already deduplicated events do not
activate again. A revoked session cannot create NEW accepted occurrences.

The processing result can arrive after detach: this is *pre-accepted work*,
not retained live session authority. A cursor write from the stale session
must remain forbidden. **The host must independently re-check access to
queued or subsequently resumed external effects**; EI does not authorize
them based on accepted source evidence.

This does **not** grant atomic revocation across separate EI processes
sharing PostgreSQL, guarantee a producer credential has stopped producing,
or cancel already queued host work. The cross-worker host registry/authority
generation fence and exact source append/CEP transactional boundary remain
#45 blockers. No provider OAuth or host policy engine was added to EI.
