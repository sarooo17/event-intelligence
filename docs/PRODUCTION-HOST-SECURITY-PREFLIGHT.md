# #317 independent deployed-host security preflight (operator runbook)

**2026-10-31 — audit tooling / observed baseline. NOT an independent certification.**
The generic EI SDK #45 security guarantees are separate from a specific
host's credentials, transport and final effect permissions. This runbook
is a preparatory **read-only, redacted** operator inventory. It cannot grant
authority, silently enable strict mode or establish a human security signoff.

## Current first-party Railway staging observation (not an enterprise deployment)

Source: read-only Railway service/env inventory and environment VARIABLE
NAMES in project `ei-validation`, environment `staging`,
recorded 2026-10-31. No variable VALUES or credentials collected,
published or asserted. Operator must recheck actual deployment SHAs
and live process runtime before concluding anything from this snapshot.

| Property | Observed | What this does / does not establish |
| --- | --- | --- |
| EI worker services | `ei-worker-a`, `ei-worker-b`, separate single-replica services, EU West | Two process/service locations, not independently secured host writers |
| Shared state | single `Postgres` service, image `postgres:16`, volume `ei-validation-postgres-data` | Shared PG16; **no HA primary failover/RPO/RTO observed** |
| Synthetic benchmark/receipt | `ei-benchmark` and artifact volume | First-party synthetic provider and host-effect domain, NOT separate source-truth oracle |
| Reference host | `muffin-openai-ei-once` from maintained `sarooo17/muffin-agent` fork | A separate Railway service, **not independently maintained external host signoff** |
| Strict-mode **variable name** | `EVENT_INTELLIGENCE_REQUIRE_SHARED_STORE` absent from BOTH EI worker variable name inventories | **Fail-closed finding for #317 acceptance 3**: the deployment cannot yet prove required strict-mode preflight |
| Worker authority epochs | `authorityEpoch` value/host-owned freshness NOT observable from Railway variable-name inventory | **Unverified**; never infer epoch from presence of `DATABASE_URL` or `EI_SCOPE_ID` |
| Final host effect and revocation | No independent hostile-producer revoke/replay/queued-effect host evidence | **Unverified**; reference receipts do not imply host effect authorization |
| Transport/quotas | No runtime-bound compressed body/time limit or tenant quota witness | **Unverified**; EI's decoded JSON validation is not a transport raw-body cap |
| Independent assessor | No completed external human 12-boundary audit or signed acceptance | **Unverified**; Codex review of source PRs is not that assessment |

**Do not set `EVENT_INTELLIGENCE_REQUIRE_SHARED_STORE=true` by blindly
adding the variable in staging.** The runtime also requires enabled
MCP connections to supply safe **host-owned authority epochs**, with
`PostgresEventStore({requireMcpSessionFence:true})` on every EI worker
touching that shared scope. Enabling the env without that wiring can
intentionally fail closed and affect live workloads. First enumerate
which services actually instantiate EI MCP connections and which are
only synthetic benchmark ingress. Do not invent source epochs from event
payloads; do not rotate provider API keys as a shortcut.

## Operator procedure to make progress (do not mark signoff complete)

1. Freeze the exact source SHA per EI worker and independently operated
   host; record a stable source/deployment/region identity, no secrets.
   Verify all shared writers, including delayed/background/legacy writers
   and dynamic attached connections. A present env var name does **not**
   prove its effective value or the actual store constructor options.
2. Instrument **startup self-observation** of the *effective* strict
   `requireMcpSessionFence` flag, with a redacted proof digest of
   host-issued authority epochs. Export only configuration assertions,
   never raw epochs/identities, bearer tokens or DATABASE_URL.
3. In an isolated PG16 database with at least two OS-worker processes,
   run a mixed strict/unfenced-writer negative and confirm the strict
   mode rejects unsafe attachment/startup. Validate session
   revocation/rebind and owner/tenant isolation against the exact
   persisted state and source IDs; preserve blocked effects and receipts.
4. Use a separately **maintained/operated** host and real detached MCP
   source; send adversarial stale/revoked traffic while a wake is queued.
   Verify host permission *again* when final effect executes and durable
   host-owned idempotency on network abort/retry/restart. An EI receipt
   alone does not show the host's external effect happened exactly once.
5. Enforce raw HTTP/RPC compressed-body byte caps, timeout, tenant
   rate/backpressure quotas and permission cancellation **in the host**
   or its proxy; preserve redacted pass/fail raw evidence, actual error
   responses and per-tenant identity separation.
6. An actual independent security reviewer (not the adapter author)
   examines every boundary in `docs/security-threat-model-v1.json`,
   reviews current source and artifacts, remediates findings and signs
   accepted residuals. No CI agent review substitutes for this step.
7. Before any production/enterprise security claim, reconcile operator
   source and evidence checksums and the authorized owner signoff.
   Never prune revocation tombstones until a separate source-authenticated
   safe replay floor is actually proven. No auto-deploy/rollback/writes
   are part of this preflight.

## Read-only machine preflight

`assessDeployedHostPreflight(inventory)` in
`scripts/validation/deployed-host-security-preflight.mjs` accepts a
redacted, operator-collected inventory of **worker variable NAMES**,
exact SHA, runtime-effective flag witnesses, nonsecret epoch **hash
commitments**, host-owned probe artifact digests and human assessor
metadata. It rejects omitted strict flags, a single/duplicate worker,
unproven mixed-legacy exclusion, missing revocation/quotas/transport,
missing PG failover and independent reviewer fields. Never insert actual
secrets into this JSON; the output reports only **coded failures**.

A complete input returns `operator-evidence-ready-for-independent-verification`,
**not** `certified`. The helper does not verify the externally asserted
observations are true; that remains the human operator/reviewer task.
`deploymentCertified` and `externalSecuritySignedOff` remain FALSE
regardless of supplied input. The actual Railway staging observations
above therefore do not satisfy #317 acceptance #1–#5.

Related: [#317](https://github.com/sarooo17/event-intelligence/issues/317)
and [#376 E317-A/B/C](https://github.com/sarooo17/event-intelligence/issues/376);
SDK v1 #45/#47 are already implemented, but different claims.
