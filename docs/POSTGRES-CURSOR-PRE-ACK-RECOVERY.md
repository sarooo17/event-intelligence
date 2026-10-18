# PostgreSQL cursor-before-checkpoint wake recovery (#47)

This real PostgreSQL16 CI fixture exercises the failure ordering:

1. Persist an MCP Events **opaque cursor A** for one exact
   `(scope, connectionId, eventName, source arguments)` identity.
2. The first worker ingests a real MCP-shaped occurrence through
   `CompositeEventConsumer.ingestMcpOccurrence`, produces a Pattern v2
   match and delivers a host-owned callback receipt, all durably stored.
   **No cursor B checkpoint is written yet.**
3. The original PostgreSQL pool closes, discarding its physical DB
   sessions. A second, independent pool reopens the same durable EI scope.
   It still reads cursor A and the original delivered wake receipt.
4. Because the cursor never advanced, the same provider occurrence is
   replayed with the **same provider source ID and subscription arguments**.
   EI returns the original fired match and wake without re-invoking the
   host callback.
5. The new worker explicitly records cursor B, ingests a **new** source
   event, persists a distinct delivered wake and confirms two fired
   matches, exactly two host effects and the updated cursor.

**Test:** `test/postgres-cursor-pre-ack-recovery.test.mjs`, exercised with
the real PostgreSQL16 service by `npm run test:postgres`.

This is a deterministic simulation of a crash boundary using sequential
**database pool teardown**, not a child-process SIGKILL, actual MCP Events
client polling lifecycle, real provider cursor transaction or upstream
network outage. The callback is synthetic and remains in this test
process across pool teardown. Therefore the proof establishes persisted
source replay and host wake idempotency for this controlled window,
**not exactly-once remote side effects**. It does not establish the
separate after-external-delivery/before-EI-receipt crash window, distributed
high-availability loss budgets, arbitrary asynchronous cursor checkpoint
ordering, or a multi-hour chaos test. All other #47 acceptance work stays
open. No production EI API/schema/consumer change is made.
