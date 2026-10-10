# Bounded PostgreSQL HA lease-chaos regression

Tracking [#47](https://github.com/sarooo17/event-intelligence/issues/47) and [#21](https://github.com/sarooo17/event-intelligence/issues/21).

The PG16 integration suite now repeats a known hazardous worker handover under controlled logical timestamps, without sleeps or random scheduling delays:

- 20 separately persisted wake deliveries; four contenders (two independent `pg.Pool` instances) attempt the same wake at once.
- Exactly one winner per wake. Another worker cannot take over **one millisecond before** lease expiry but can take over once expired.
- Previous owner's stale completion is rejected even if it arrives after the successor's claim.
- Only the successor's receipt is durable; completed deliveries cannot be re-claimed.
- Two independent tenant scopes may use the *same* wake/match/trigger ID concurrently and persist different receipts, without overwriting each other.

CI uses a real PostgreSQL 16 container. The regression does **not** exercise process termination, connection-pool kill, DB failover, network partition, multiple hosts using different physical nodes, long soak, or 1k/10k/100k trigger benchmarks. The test is a bounded adversarial concurrency check, **not a production SLO or HA certification**.

Reproduce:

```bash
POSTGRES_URL='postgresql://...' npm run test:postgres
```

The package's existing PG suite also verifies lifecycle CAS, audit chain and trigger mutation locking; this adds many repeated wake-claim handover attempts and exact cross-tenant key isolation. Additional chaos and scale acceptance criteria remain open in #47.
