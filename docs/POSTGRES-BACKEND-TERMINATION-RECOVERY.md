# PostgreSQL backend termination / wake recovery evidence (#47)

This isolated PG16 integration test deliberately kills a **real server-side
PostgreSQL backend PID** with `pg_terminate_backend(pid)` while an SQL
`pg_sleep` call is in progress. It is distinct from a graceful
`pg.Pool.end()` reconnect or an OS worker SIGKILL. The scenario is repeated
four times against randomly named tables and independent `pg.Pool` objects.

For each round, EI first durably persists a wake claim and a partition lease
without recording any runtime receipt. Server-side backend termination causes
the pending SQL query to fail. The original worker's pool is then replaced.
An independent pool verifies the claim is still durable and has not acquired
a synthetic receipt; it cannot steal either lease before expiry.
At logical lease expiry the survivor reclaims generation 2, while the stale
generation 1 finalization is rejected, including **same worker ID** ABA.
A durable receipt then prevents future redispatch. Cleanup of all isolated
tables is required for success.

The test is added to `npm run test:postgres` and therefore requires the
same isolated PG16 service, appropriate `pg_terminate_backend` privilege and
optional `pg` test dependency used by existing PG16 CI.

**Limits:** the killed backend executes a deliberately pending fixture SQL
operation, *not* an in-flight wake-delivery transaction. This is **one
backend/socket failure**, not whole-server outage, database primary failover,
network partition, provider or remote host transport, or long soak. No
production SLO, RPO/RTO, no-loss invariant during arbitrary provider
failures, or live independent infrastructure has been certified. More
evidence is needed to satisfy #47; the test changes no runtime API/schema.
