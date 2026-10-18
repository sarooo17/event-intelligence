# Source/event-aware PostgreSQL candidate projection — issue #47

## Why

The PostgreSQL-backed `CompositeTriggerEngine.ingest()` historically loaded
**all trigger definitions** for every non-timer event, then applied the
existing in-memory clause and lifecycle gates. This remains correct but
requires transferring and parsing irrelevant persisted definitions when
many sources share a tenant.

This PR adds a **fresh, scoped, source/event candidate query** to the
PostgreSQL store, consumed through the new optional
`listTriggerCandidatesForEvent({name,serverId})` contract. All other stores
and host adapters remain supported through the original `listTriggers()`
fallback; timer events deliberately keep the original path.

## Selection contract and safety

The PostgreSQL query reads current durable rows at **each ingest**, scoped
by `scope_id` and `kind='trigger'`. It returns the union of:
- Definitions containing a clause whose **event name** equals the received
  event and whose **serverId** is equal or unspecified (a wildcard).
- Definitions with an `expiresAt`, `leaseUntil`, `oneShot`, or
  `maxFirings` lifecycle condition, **even when none of their clauses
  match**: the existing engine must still run lifecycle transitions and
  preserve corresponding state and audit effects for unrelated events.

The candidate query does **not** filter by actor, owner, lifecycle status,
credential, connection ID, subscription argument predicates, contract version,
or event data predicates. Current authoritative `getTriggerState()`,
`lifecycleAllows()` and canonical `clauseMatches()` remain the only
gatekeepers for matched definitions. Regex predicates are completely
unchanged, and still execute only in the previous lifecycle-gated branch.

Candidates are ordered by the existing `record_key` ordering. On registration,
delete, pause or scope change, the next query reads current durable state;
there is **no long-lived cache, cross-scope sharing or stale index**. The
projection is a conservative *superset*, never an assertion that a trigger
is authorized to fire. An incorrect custom store implementation of the
optional contract could omit candidates; callers must not implement it with
eventual consistency or incomplete lifecycle exceptions.

## Storage/index migration trade-off

This is a **SQL JSONB prefilter and live candidate projection**, not a
physical GIN index or a new persistent materialized table. PostgreSQL still
may scan many stored rows to evaluate the JSONB predicate. The benefit is
reduced definitions transferred and parsed by Node.js when **many distinct
sources/event names** exist. A physical index must be designed and migrated
separately (including existing populated stores, concurrently-built indexes,
versioning and rollback) rather than silently added at startup.

## Evidence

- `test/postgres-source-aware-candidates.test.mjs` on real PG16 checks
  matching server IDs and wildcard clauses, exclusions for nonmatching
  sources, lifecycle exceptions, dynamic registration, pause/deletion
  read-fresh guarantees, distinct scope isolation and actual engine match,
  pause and expiry behavior. All scoped data is fixture isolated.
- Existing generic JSONL and custom-host tests exercise the unmodified
  `listTriggers()` fallback, preserving compatibility.
- The benchmark reports `totalRegisteredActiveDefinitions` separately
  from **actual per-event candidate projection sizes** (sample count,
  min/max/mean), recorded around the exact database projection call
  during measured matching events. Under this fixture shape the 1-event
  profile returns about 1,000 definitions per event, while the
  20-event-name profile returns about 50; these are *observed candidate
  counts*, not proof of a physical indexed lookup.
- `postgres-active-1000-evidence.yml` now runs **two independent**
  real PostgreSQL16 jobs: 1,000 eligible single-event triggers and
  16 serial samples, in either **1 event name** (baseline) or **20 event
  names** (50 definitions per name). The matching, noise, replay, receipt,
  independent pool-reopen and fail-closed assertions run in both.
  Both jobs use identical workload *shape*, but different isolated
  GitHub runner machines. Never interpret p95 or throughput differences
  between jobs as a stable speedup without repeated controlled profiling.

## Still open for #47

A real persisted GIN index, batch lifecycle reads with safe compare/append,
full AST correlation and multiple sources under high cardinality, 10k/100k
*live* matching, long soak/restart, retention and RPO/RTO. No npm release,
Muffin/Artemis pin update, physical schema mutation or operator migration
is performed.
