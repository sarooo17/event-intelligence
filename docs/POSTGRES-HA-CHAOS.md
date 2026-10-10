# Bounded PostgreSQL HA lease-chaos regression

Tracking [#47](https://github.com/sarooo17/event-intelligence/issues/47) and [#21](https://github.com/sarooo17/event-intelligence/issues/21).

The PG16 integration suite now repeats a known hazardous worker handover under controlled logical timestamps, without sleeps or random scheduling delays:

- 20 separately persisted wake deliveries; four contenders (two independent `pg.Pool` instances) attempt the same wake at once.
- Exactly one winner per wake. On alternating rounds, either a different worker **or the same worker with a new claim generation** takes over after expiry. Attempts cannot take over at expiry−1ms but may at the exact expiry boundary.
- Previous owner's stale completion is rejected even if it arrives after the successor's claim.
- Only the successor's receipt is durable; completed deliveries cannot be re-claimed.
- Two independent tenant scopes may use the *same* wake/match/trigger ID concurrently and persist different receipts, without overwriting each other.

CI uses a real PostgreSQL 16 container. The regression does **not** exercise process termination, connection-pool kill, DB failover, network partition, multiple hosts using different physical nodes, long soak, or 1k/10k/100k trigger benchmarks. The test is a bounded adversarial concurrency check, **not a production SLO or HA certification**.

Reproduce:

```bash
POSTGRES_URL='postgresql://...' npm run test:postgres
```

The package's existing PG suite also verifies lifecycle CAS, audit chain and trigger mutation locking; this adds many repeated wake-claim handover attempts and exact cross-tenant key isolation. Additional chaos and scale acceptance criteria remain open in #47.

## Reconnect and stale-generation fencing (additional bounded regression)

The PG16 integration suite also seeds eight independent claimed wakes through
one connection pool, fully closes that pool, constructs a new PostgreSQL pool
and store instance, and verifies:

- Claimed records remain durable and unread receipt state is not fabricated
- A new claimant cannot take over at expiry−1ms, but can at the exact boundary
- A restarted worker reusing the **same logical worker ID** receives a new
  attempt generation; the old generation is denied with
  `WAKE_DELIVERY_CLAIM_LOST` even when the worker name matches
- Only the newer receipt survives subsequent store reconstruction and delivered
  wakes cannot be claimed again

This explicitly tests **pool reconnect**, not independent operating-system
process termination, PostgreSQL primary failover or a real network partition.
It adds restart evidence but does not discharge the soak / partition-rebalance
or performance SLO checkboxes in #21 and #47.
