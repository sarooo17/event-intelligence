# Durable semantic budget policy identity — no silent quota bypass

The host-owned PostgreSQL budget admission ledger now pins the complete
normalized policy (trigger and batch call/token/cost ceilings, both DB-clock
admission windows) under an immutable **policy fingerprint** for each
scope, trigger namespace and budget epoch.

Every worker serializes through the same scoped trigger advisory lock. A
worker that accidentally reuses an existing epoch with larger, smaller
or different batch ceilings now gets
`EVENT_INTELLIGENCE_SEMANTIC_BUDGET_POLICY_CONFLICT` *before* any
reservation or provider invocation. A fresh batch ID cannot bypass
the original epoch policy; different tenants remain independent.
A deliberate host-owned new policy epoch starts a new budget and must
remain a trusted, audited operator action, never be accepted from
untrusted MCP event data.

Pre-existing ledgers from before policy pinning are **intentionally refused**
when used with the new implementation until the operator chooses a fresh
explicit epoch. Silently adopting legacy unpinned counters would permit a
higher-cap worker to lift the old quota and undermine strict semantics.

This is still **trusted estimated upper-bound token/cost accounting**:
EI cannot certify a provider's actual billing if its host supplied an
underestimate or an adapter ignored the cooperative AbortSignal.
Tests cover concurrent PG16 pools, restart/reopen, mixed and increased
policies, fresh batch bypass, cross-tenant isolation and explicit epoch
rotation. No provider SDK is added.
