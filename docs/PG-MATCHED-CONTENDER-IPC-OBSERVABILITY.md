# Matched-worker IPC outcomes vs durable completion

The isolated real PostgreSQL OS contender test guards a durable truth:
one unique match, exactly one host call/effect, a finalized EI wake,
the same durable host receipt, and no redispatch after replay.

When two scheduler processes contend, the per-worker reported
`wake_delivered` / `claim_lost` / `delivery_in_progress` / `no_work`
statuses are **advisory process observations**. Concurrent claim movement
means neither process is required to report the string `wake_delivered`
even when the authoritative DB state has delivered and all effects
are accounted for. Conversely one process reporting it is *not* enough
to prove the persisted host effect. The test therefore accepts the
bounded status vocabulary but requires the more stringent, existing
database proofs, plus exactly one host invocation.

This modification removes only an unreliable IPC-observer prerequisite.
It does **not** remove any durable-state, effect-count, receipt, replay,
SIGKILL or worker-exit assertion. The production engine is unmodified.

Issue #47 remains open for production SLO/retention/failover validation.
