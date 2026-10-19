# Scoped PostgreSQL candidate optimization: conservative numeric equality (#47)

## Root cause and scope

The merged [#224](https://github.com/sarooo17/event-intelligence/pull/224)
eliminated three **whole-trigger-registry reads after each match**.
The remaining 100k-single-source ingress spent most of its measured
time **before** the first match: the PostgreSQL source-aware candidate
projection returned and parsed up to 100,000 definitions with the same
event name even though the synthetic test event matched only one
definition's exact `where: [{path:'slot', op:'eq', value:N}]`.

The optimization adds optional parsed event `data` to the existing
source candidate projection. For an event whose data is a **flat JSON
object** containing only null, string, boolean or safe-integer values,
PostgreSQL may reject a source-matching *single-clause alternative*
**only** if its `where` array has exactly **one** direct top-level
numeric `eq` predicate and the supplied JSONB value does not match.
The previous event-name/serverId test still applies.

This is a **superset prefilter**, not a second interpretation of Pattern
v2. Every remaining trigger definition still passes canonical
`clauseMatches`, live lifecycle/state checks, replay identity,
Pattern v2, wake dedup and host receipt fencing in the normal engine.

## Fail-open boundaries

The old source-only superset is retained when the optional `data`
argument is absent, null, array, nested, fractional, exceeds safe
integer precision or otherwise requires a complex interpretation.
A `where` clause with multiple predicates, a dotted/nested path,
string equality, regex, time window, `contains`, semantic logic etc.
also remains in the returned source candidate set. If a definition has
multiple source-matching clauses, PostgreSQL tests **each alternative**
within the same `EXISTS` condition; rejecting one cannot hide another
candidate. Definitions with expiry, lease expiry, oneShot or
maxFirings lifecycle state transitions are included even when their
source name or predicate does not match. The current-state gate is
always handled by the engine, never cached.

The optimization requires no schema migration, new indexes, tenant
cross-scope reads, persisted projections, TTL, debounce or stale
in-memory caches. It doesn't modify regex evaluation or security
policies. PostgreSQL still scans source candidates and tests JSONB
expressions; **this is not a claim of O(1) database matching**.

## Actual evidence

`test/postgres-safe-numeric-eq-prefilter.test.mjs` on real PG16
checks matching/mismatching integer predicates, two alternative
clauses, multiple predicates, numeric fractions, nested paths,
string/regex, serverId scope, dynamic registration, paused
definitions, tenant isolation and unrelated lifecycle expiry.
It also requires the no-`data` legacy behavior to be unchanged.

The isolated heavy benchmark reruns actual 10k/100k definitions using
`postgres-active-large-evidence.yml`. Result JSON now explicitly
separates the number of definitions eligible **by source event name**
from `candidateDefinitionsPerMeasuredEvent` (rows fetched after
the conservative numeric prefilter). One returned candidate for
the 100k-single-source synthetic fixture does **not** mean EI tested
only one registered trigger or reduced host-wide cardinality.

Read only the actual raw CI run artifacts for measured timings and
resource data; code/commit or passing a small smoke alone cannot
certify a speedup. These bounded fixture events do not constitute
statistically sound p95/p99, sustained burst/queue load, real remote
provider/host SLO, multiworker failover or complete #47 performance
acceptance.
