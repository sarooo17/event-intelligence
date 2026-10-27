# Cancellation-safe PostgreSQL 600s manifest publication

The outer real-OS chaos campaign (issue #47, PR #263) publishes its
`manifest.json` **only after** collecting every raw cohort and validating
the actual 600s active-process budget.

The observer checks cancellation on *both sides* of the asynchronous file
write. A signal during that write invalidates the completion status and
removes the manifest, even when the file write itself succeeded. A partial
or failed write also triggers cleanup. This prevents a failed/cancelled
campaign from leaving a complete-looking success manifest.

`test/postgres-os-600s-publish.test.mjs` explicitly simulates a cancellation
when the writer is awaited, a failing partial writer and pre-cancelled
runs. These are EI-owned, deterministic unit tests; they **do not**
substitute for a new 600-second PostgreSQL run or a production SLO.

Review the remaining outer OS cohort cancellation behavior separately;
a success manifest is not proof of real provider or host uptime.
