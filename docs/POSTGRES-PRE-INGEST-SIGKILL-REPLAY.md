# Real process SIGKILL after provider delivery and before EI persistence (#47)

This bounded PostgreSQL 16 integration test fills a previously **unproven
provider-event-before-EI-persistence** crash boundary in the v1 recovery
matrix. The test uses three stable MCP-shaped source events delivered from a
test-owned PostgreSQL outbox, and forks **separate Node OS processes**.

For each event, an independent worker first polls a provider event and
reports receipt **without** entering EI's consumer or acknowledging the
provider. The parent verifies that EI has no new persisted match, the
source cursor has not advanced, and the provider outbox still retains the
unacknowledged event. It then kills the worker using a real OS SIGKILL
and waits for process exit.

A new OS worker then polls the same provider event ID, same server and
subscription arguments through
CompositeEventConsumer.ingestMcpOccurrence(). Its canonical Pattern v2
engine commits the match; CompositeWakeCoordinator durably commits a
host-owned receipt. Only **after** that success does the recovery worker
advance the EI MCP source cursor and acknowledge the event in the
independently owned provider outbox.

A third fresh worker forcibly replays that exact acknowledged event.
The original match/wake/receipt must be reused with already_fired;
no duplicate external host callback may run. The parent checks across
all three rounds: one fired logical match and one host-side effect
per distinct provider event, unchanged receipt attempt generation for
replays, monotonically advanced source cursor, no missing events,
source ACK state and a valid PostgreSQL audit chain.

The test uses three uniquely prefixed, disposable fixture-owned tables
(provider_outbox, host_effects, host_attempts) in the same
PostgreSQL test instance. They are outside EI's durable store. The host
effect table has a uniqueness constraint on stable EI wake ID. No
production schema, runtime API, regex, release or downstream consumer
integration is changed.

**Precisely what this proves:** real OS worker loss *after a retained
provider event has reached a worker but before the EI ingest entry
point*. Assuming an upstream source retains and replays unacknowledged
events, a new worker can recover and process the same stable ID. The
actual process kill is real; provider retention and replay are supplied
by an isolated, deterministic database fixture.

**What this does NOT prove:** real remote MCP Events polling/subscribe
delivery over a network, webhook retries, provider-specific replay
retention and truncated-history handling, an OS SIGKILL *mid-transaction*
inside EI.ingest(), atomicity between provider ACK and EI persistence,
reliability if the provider drops the event, independent-database network
faults, production RPO/RTO/SLO or globally exactly-once effects.

Run with POSTGRES_URL in the existing npm run test:postgres CI gate.
No database name, password or DSN is sent through IPC messages.
#47 remains open for long-soak chaos, compaction and measured scale/SLOs.
