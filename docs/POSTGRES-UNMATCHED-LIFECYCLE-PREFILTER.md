# Avoid nonmatching lifecycle lookups (issue #47)

## Observed problem

The 1,000-eligible-definition real PostgreSQL benchmark repeatedly took
hundreds of milliseconds per event before durable wake. Prior to this PR,
the canonical `CompositeTriggerEngine.ingest()` iterated all definitions
and performed `getTriggerState(triggerId, version)` for **every**
definition, even when none of its clauses could match the event. With a
PostgreSQL store this produced up to 1,000 independent lifecycle reads per
event. This is an implementation observation, not a claim that every
microsecond in the prior benchmark was spent inside PostgreSQL.

## Conservative optimization

Only definitions that **cannot transition lifecycle on a nonmatching
event** are prefiltered by `clauseMatches()` before the lifecycle read.
For a negative clause match, we skip the useless read; for a positive
clause match, we still read the **current** authoritative lifecycle
state and run the **original** `lifecycleAllows()` policy before
performing match, partition lease, wake or audit effects.

Definitions with a potential **time expiry, leaseUntil expiry, oneShot
completion or maxFirings completion** retain the **original ordering**
even when the event cannot match: state read, lifecycle check and its
possible persisted transition/audit run before clause filtering.
Cooldown-only definitions have no lifecycle mutation from unrelated
events, so they can be skipped. Paused/deleted/completed matching
definitions are still stopped by the exact same authoritative state gate.

This is a **control-flow optimization only**: no new caching of mutable
owner/state, no tenant/global cross-scope lookup, no runtime-name
dispatch, no schema or API changes and no fallback to stale lifecycle
state. No authorization, source identity or event evidence is delegated
to EI. Source/argument/predicate matching remains the canonical
`clauseMatches` function.

## Evidence and acceptance

`test/composite-unmatched-lifecycle-prefilter.test.mjs` checks:

- 48 unrelated registered definitions, with only the one matching
  definition causing a lifecycle state lookup; paused matching
  definitions remain blocked; mismatched subscription arguments
  generate neither reads nor matches.
- Unrelated yet expired definitions still transition to `expired`
  and write verified audit records, including `leaseUntil` expiry.
- `oneShot` and `maxFirings` states already above their limits still
  transition to `completed` even when clauses do not match.
- A cooldown-only unrelated definition requires no lifecycle read.

The changed `src/composite/engine.ts` path also triggers the isolated
1,000-eligible-definition/16-serial-event PostgreSQL Actions benchmark,
alongside the existing 8/16 small pipelines. All artifacts must be
interpreted with Node version, PostgreSQL service version and runner
information. Baseline unoptimized exact-head run
[39147378552](https://github.com/sarooo17/event-intelligence/actions/runs/39147378552)
reported in-process MCP→wake p95 **484.064ms**, **2.362 serial events/s**
with 16 observed events. Another earlier unoptimized run
[39146931042](https://github.com/sarooo17/event-intelligence/actions/runs/39146931042)
reported p95 **280.691ms**, **4.505/s**; runner variance prevents
interpreting small-sample relative timings as a stable speedup.

Remaining costs include scanning/parsing all persisted trigger
definitions, predicate matching against every eligible candidate and
DB reads for any actual matches or lifecycle-mutating definitions.
Optimizing those costs with source-key routing or batched lifecycle
state access requires a **separate, reviewed design** to preserve
dynamic trigger changes and host authority. This PR does not establish
10k/100k active CEP matching, high-cardinality temporal/semantic
correlation, multi-worker sustained throughput, remote provider-to-host
SLOs, long chaos soak or production readiness. #47 remains open.
