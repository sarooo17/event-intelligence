# #376 E48-A: deployed first-party source negative fault matrix (2026-11-01)

**Not an independent production/provider certification.** The positive
staging path was independently reviewed and run successfully on Railway
from main SHA `17dfdd9f75997793718f6e619f6e3b48117c232d`.
One live raw source archive and actual PG16 match/wake/host receipt were
reconciled using pinned signer public key; see issue #376. That test is
a **positive path**, not the full required E48-A fault matrix.

## Additional repeatable negative matrix

`scripts/validation/live-source-fault-matrix-once.mjs` is a **one-shot**
staging operator script that targets the already-deployed, private-network
`ei-source-oracle-staging` service and its isolated fixture log. Inputs
are Railway references to the existing source's operator token, public
trusted signer key, source identity, and **pinned source SHA**. It
intentionally never prints token, raw archive, private key, event data or
full signature. It performs these checks:

| Case | Method / accepted scope | Evidence needed |
| --- | --- | --- |
| Healthy | Real authenticated source status, event append, seal, source archive, independent Ed25519 oracle | Exact source SHA, log head/sequence, archival digest, redacted verdict |
| Delayed / omitted at consumer | Persist real event, deliberately postpone consumer observation, then follow **real paginated** source replay to recover it; standalone oracle confirms it exists | No claim that a consumer with an incomplete view knows upstream is complete |
| Replay / duplicate | Same real source event ID twice with matching payload | Second append rejected as duplicate, no second durable occurrence |
| Backdated | Real source reject of user-supplied `occurredAt` | No signed complete-through behind an already sealed frontier |
| Truncated/missing transport | **Adversarial response injection in validator only** with `truncated:true`; actual source intentionally never truncates its full log | Fail-closed receiver semantics are covered separately in the real PG16 suite; never claim the live provider naturally emitted a gap |
| Wrong/rotated public key, tenant, revision, expired, tampered | Same real signed source claim/privately retrieved log against independently pinned wrong trust roots or identity | Independent oracle rejects all mismatches; no false provider-finality upgrades |
| Revocation and epoch | Real source operator `revoked:true`; poll, append, frontier must fail; archive must retain revocation; restore then **old seal must be invalid**, new signed epoch required | Restore on **every** exit including failure; read-only raw log archive and new source head checkpoint |
| Provider unavailable | Connect to an invalid private-network port rather than restarting source | **Simulated transport outage only**; no actual source process crash/primary failover claimed |
| Signed terminal candidate boundary | `test/standalone-source-pg-fault-matrix.test.mjs` runs real PG16 source-backed Ed25519 signed frontier; proof binds true PG tenant/source digest/revision. Selected expired candidate becomes `candidate_impossible` **only** after authenticated live monotonic seal and healthy source; foreign tenant remains pending; first gap/revocation invalidates proof. | PG16 exact source revision, signed witness, inspector negative reasons (CI, not a third-party production source) |

## Important limitations and operations

- This source is a **first-party experimental provider** with a
  **first-party** oracle independently implemented and a separate OS/service,
  not a separately owned enterprise source. A signed event-time seal
  authenticates the provider's claim, not third-party business truth.
- The initial long-running staging fixture's source digest is explicitly
  configured and **is not automatically the host's canonical PG
  `mcpStateKey` digest**. Do not pretend that the original fixed
  source-signer snapshot can authorize an arbitrary per-run PostgreSQL
  tenant. The new PG16 test generates the exact correct host source
  digest from `connectionId::eventName::canonicalArguments` in its
  isolated scope. A genuinely end-to-end deployed candidate
  `candidate_impossible` test needs a dedicated source instance
  with its on-disk genesis identity matching the real host scope,
  connection and digest, plus an actual EI MCP consumer.
- During the real revocation test the isolated source is unavailable
  briefly: execute only on the **validation fixture** and never on an
  unrelated real customer source. The script's `finally` always attempts
  to restore the source to available; if network failure prevents that,
  the run MUST fail and request operator attention. Do not silently
  repair/purge a stale source lock or persisted revocation tombstones.
- Fault injection is not a substitute for a real externally operated
  source, independent human reviewer or primary-HA failover metrics.
- Publish only redacted counts, SHA-256 digests, exact source commit and
  deployment IDs as issue evidence, not source archive or secrets.
- Mark E48-A **only after** all actually required cases, especially
  real source/consumer gap handling and candidate diagnosis, are
  replayable with pinned raw artifacts and review. Synthetic
  truncation/outage must remain labeled simulated.

The separate #317 host security certification and #376 E48-B,
E49-A/B, E47-A/B/C and E317-A/B/C remain independent acceptance gates.
