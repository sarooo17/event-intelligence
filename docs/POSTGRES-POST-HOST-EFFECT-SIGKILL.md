# SIGKILL after host effect before EI receipt — at-least-once boundary (#47)

This real PostgreSQL16 integration fixture tests the **ambiguous external
delivery window** with **three genuine SIGKILL subprocess terminations**.

For each durable Pattern v2 match, an independent EI worker builds the
real generic wake packet, obtains a wake claim, invokes a separate
**test-only host with its own durable PostgreSQL table**, and commits a
host-side effect keyed by the stable `packet.wake_id`. The host then
acknowledges that effect to the test controller through IPC but **never
returns the receipt to EI**. The controller verifies that the host effect
exists, while EI's claim is still `claimed` with no receipt, and sends
`SIGKILL` to the original worker PID.

A new process takes over at the exact **synthetic** lease-expiry time.
EI retries delivery (at-least-once). The host's separate durable table
recognizes the same `wake_id`, returns the original receipt and
`duplicate:true` instead of reapplying the effect. EI persists receipt
generation 2 and marks the original match fired. A third independent
PG pool verifies all receipts. Per wake the host table contains
**one effect but two delivery attempts**.

## What this proves and what it does not

- An actual OS process can die **after a host-controlled durable effect**
  and **before EI's durable receipt**, and EI can resume at the
  persisted lease boundary.
- The host **must** implement stable-key idempotency to prevent a
  duplicate effect in this inherently ambiguous window.
- EI provides *at-least-once delivery attempts*; a properly idempotent
  host can achieve **effectively-once host effects** for the same wake.
  EI alone **cannot guarantee globally exactly-once** external side
  effects. A non-idempotent host may perform the effect twice.
- The example host is an independent test-only PostgreSQL table, **not**
  a production Muffin, Artemis, or remote HTTP TurnStore. Host
  authorization, exact target semantics and policy remain host-owned.
- SIGKILL is real; lease expiry is exercised with a synthetic logical
  clock, not by waiting on wall time. This is bounded deterministic CI,
  not a 24-hour soak, network partition, or production RPO/RTO proof.

Files: `test/postgres-post-host-effect-sigkill.test.mjs` and
`test/fixtures/postgres-post-host-effect-worker.mjs`.
The test runs in `npm run test:postgres` on GitHub's PostgreSQL16
service. It uses randomly named disposable tables and no production
credentials or schema changes. It does not touch regex behavior,
release packaging or downstream integrations.

The earlier #210 establishes the *before host-effect* crash boundary;
this case is intentionally distinct. #47 remains OPEN for full
network-level and long-soak evidence.
