# PostgreSQL 16 physical standby SIGKILL / promotion drill (#47)

**Goal:** measure physical PostgreSQL recovery when a separate streaming standby is synchronously applying WAL. This is a reproducible disposable CI **real process** test; it is not Railway's current single-database HA service and does not certify production RPO/RTO.

The workflow PostgreSQL physical standby failover RPO RTO (disposable) provisions two distinct Docker PostgreSQL 16 server processes and a real pg_basebackup -R physical WAL standby, waits for streaming sync_state=sync, and sets each benchmark commit to synchronous_commit=remote_apply. The harness verifies 200 acknowledged row+SHA receipts on the standby **before** the primary kill, kills only the explicitly labeled disposable primary container with SIGKILL, invokes pg_promote on the independent standby process, waits for writable transactions and rereads the full original receipt sequence.

Expected raw artifact: pg-physical-failover.json (attached to the actual GitHub Actions run). It records the checkout source SHA, acknowledged transactions, lost acknowledged transactions (measured RPO in **transactions**, not seconds), RTO in monotonic milliseconds measured from Docker kill start to successful promoted write, data integrity and actual post-promotion write. The **predeclared CI-only RTO guard** is 30,000ms and a missing acknowledged remote_apply commit fails. No synthetic sleep is used to fill the recovery interval.

Safety:
- Explicit EI_DISPOSABLE_PHYSICAL_FAILOVER_CONFIRM test-only flag is required.
- The harness only allows localhost port 25432/25433, exact test db name, and a specific container with ei.disposable=yes label. It never connects to Railway, customer databases, or the EI production schema.
- Fresh fixed Docker container/network/volume names refuse preexisting resources and the script cleans up only its own disposable resources.
- GitHub workflow verifies exact checkout SHA; the raw artifact must be downloaded and checked by an independent reviewer.

Limits: Both containers share **one CI physical machine**, not AZs/regions. The RPO=0 claim applies **only** to fully acknowledged synchronous remote_apply writes after checking the standby is synchronous, not in-flight/unacknowledged traffic or async replication. The result does not include a real EI trigger/wake ledger, external host effects, provider reconnect/resubscribe, PostgreSQL leader fencing/split-brain, network partition, Rails hosting, provider-independent event-to-wake p99, or off-host WORM archives.

Do not close #47, publish a production availability SLA or enable automatic PostgreSQL failover on these results. Next step for #47 production acceptance is repeat the procedure in a multi-node/zone architecture with real EI workers and independently recorded RPO/RTO, including failover while host effects and wakes are pending.
