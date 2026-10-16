# CEP `notFollowedBy` durable deadline restart conformance

Executable finite slice of [#44](https://github.com/sarooo17/event-intelligence/issues/44):
`node --test test/pattern-v2-negative-deadline-restart.test.mjs` after `npm run build`.

The test uses the real `CompositeTriggerEngine`, JSONL
`PersistentEventStore`, `CompositeEventConsumer` and
`TemporalDeadlineScheduler` with a deterministic injected wall clock.
For 12 seeded timestamps it compares a continuously running store and a
**physically closed/reopened** store (with a new engine) across two scenarios:

- **Absent forbidden event:** the anchor starts one pending deadline;
  no timer is due at deadline −1 ms; at the exact deadline the negative
  condition can complete with its original source provenance.
- **Forbidden at deadline −1 ms:** a source event arrives before finality
  and must prevent the negative match, including after restoration.

Both branches verify the initial persisted deadline, no premature timer
completion, matched source identities, final deadline status, one-time
scheduler behavior, independent second-store reload and the hash-linked
audit chain. These are actual durable runtime paths, not an in-memory
pure-evaluator oracle.

**Scope:** a single unpartitioned two-clause `notFollowedBy`,
`allowedLatenessMs=0`, no source retraction *after* finality, fixed
synthetic UTC times, one worker and the local JSONL store. This is
not proof of complete PostgreSQL multi-writer recovery, watermark
ownership, failures *inside* a file append, or arbitrary nested CEP
negations. Late arrival after finality remains policy-dependent;
this suite specifically tests ingress before deadline. No new AST,
authorization, execution privilege or persistence schema is introduced.
