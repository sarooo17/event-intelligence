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

## Negative test mapping / non-goals release contract (#45)

`docs/security-negative-evidence-v1.json` lists all 12 authority owners,
a concrete existing negative test case for each hypothesis, and unresolved
risk. `test/security-negative-evidence-ledger.test.mjs` verifies that every
referenced **test case**, not merely a filename, remains present, and that
externally owned authorization/approval powers do not appear as new EI
package exports or silently usable MCP credentials. The security release
workflow executes this contract on every PR.

The machine-readable status is **not security certification**. The matrix
can establish a regression witness for the named attack shape, but cannot
claim that an entire boundary is comprehensively safe. Provider OAuth,
transport credential acquisition, host policy engine, agent tool permission
and execution approval, and post-wake authorization of external effects are
strictly the host's responsibility. EI's internal trigger-owner checks are
not an OAuth or downstream effects authorization system.

Pending: cross-worker revocation/queued work semantics; externally enforced
transport body/time quotas and tenant rate/backpressure; all-unlabelled
telemetry canary protection; private independent reviewer signoff. Do not
check #45's security certification acceptance on this ledger alone.

## Revocation / accepted append admission and shutdown

A host-managed MCP connection can be detached after EI has started
a durable append but before that append resolves. Once the source append
has durably accepted the occurrence, EI **must** finish the corresponding
CEP activation even if detach occurred: otherwise provider replay can see
an existing dedup ID and the accepted event is permanently stranded.
No new work is admitted from the detached session; stale cursor writes
remain forbidden and the host must reauthorize any queued external effects.

All admitted append + CEP operations are tracked by promise identity before
their first storage await, independently of reusable connection IDs. Host
`close()` drains this set before the underlying store is released, even if
the detached connection was removed from `pollInFlight`. Tests cover both
the append/revoke/rebind and append/revoke/close race.

This guarantee applies within one manager. It is **not** a global revocation
fence across processes, a transactional shared-store append+match boundary,
or cancellation of already queued host work; those remain #45 blockers.

## Provider-supplied event name privacy on error telemetry (#45)

Push/webhook provider failures and termination observations no longer
include raw provider-selected event descriptor names. Forty deterministic
unlabelled-secret canaries are exercised in the release security gate;
these strings are private even without `token=` or `Bearer` markers.
Errors retain constant messages and host-selected correlation IDs.

This does not prove that arbitrary host metadata/scope IDs or third-party
log sinks cannot contain unlabelled sensitive values; #45 telemetry-wide
acceptance and independent security review remain open.

## Privacy-safe operational telemetry by default (#45)

`createObservabilityEmitter` now defaults to `privacyLevel:'minimal'`.
It emits only a fixed allowlist of built-in EI event categories, event
severity, optional small numeric attempt count, a fixed error-presence
marker, and recognized fixed status values. It generates its own timestamp.
**No** provider/event names, opaque IDs, scope/tenant IDs, arbitrary status,
metadata, user-supplied timestamps or raw error messages are exported.
Unknown event names collapse to `ei.unknown` rather than reflecting an
arbitrary string. This is necessary because regular-expression redaction
cannot recognize an unlabelled private event field.

Operator-only `privacyLevel:'diagnostic'` (or `observabilityOptions:{privacyLevel:'diagnostic'}` on `createEventIntelligenceHost`, `createEmbeddedEventIntelligence` and the facade) restores the old sanitized
field-level telemetry shape, **but arbitrary unlabelled text remains
possible**: use only after explicit opt-in in access-controlled private
sinks. Treat diagnostic text as sensitive and apply host retention policy.
The privacy-focused regression uses 256 distinct unlabelled canaries across
all dimensions and nested metadata in the Public Release Check.

Compatibility: the operational observability schema is still v1, but its
default projection is intentionally narrower. Hosts that rely on correlation
IDs, metadata or error text must explicitly choose diagnostic mode and
review their own secret-handling and storage controls. The OTel bridge
already omitted correlations/metadata by default and remains compatible.
No runtime policy/OAuth authorization behavior changes.
