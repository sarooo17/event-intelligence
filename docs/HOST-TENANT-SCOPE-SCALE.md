# Host multi-tenant cold-start and scheduler diagnostics (#353)

This bounded diagnostic tests a known risk: the EI reference host eagerly restores **every** persisted scope and starts a temporal deadline and wake-retry interval for each scope, including inactive tenants. It is not production multiworker PostgreSQL evidence.

After building, run:

    node scripts/validation/host-tenant-scope-scale.mjs --tiers=1,10,100 --samples=3

Each replicate runs in its own Node OS process (GC enabled). The benchmark seeds exact 1/10/100 scope counts in an ephemeral JSONL store, measures cold-start wall time, RSS change and shutdown time, verifies that exactly two scheduler timers per scope are active and that their handles are cleared by host.close(), and deletes its data. The GitHub Actions workflow records a commit-pinned JSON artifact. Larger tiers up to 1000 are opt-in and are NOT certified affordable/safe.

This is EI-authored test infrastructure, not a separately authored application, actual host-billed cost, real pending-wake/restart recovery proof, PostgreSQL multiworker deployment, or an operator SLO. A three-sample min/median/max must never be advertised as a production p99.

**Architecture consequence:** reference startup has O(number of stored scopes) scheduled contexts, not O(number of active scopes). One hundred inactive persisted scopes imply 200 active interval handles per process. Any lazy alternative must still recover pending deadlines, wake retries and orphaned matches for inactive tenants. Do not turn off these schedulers without authoritative persisted recovery and independent failure injection.

**Acceptance:** #353 criterion 4 remains **unchecked**, because it additionally requires actual PostgreSQL multi-worker, retries over restart and fuller tenant tiers; this only supplies bounded idle-tenant cold-start/timer evidence. No core/runtime/package/export/API changes.