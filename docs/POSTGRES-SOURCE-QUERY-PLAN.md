# PostgreSQL source query-plan evidence (#47, follows PR #208)

This isolated real-PostgreSQL16 experiment inspects whether physical GIN
indexing **actually accelerates** the event/source candidate query proposed
in [PR #208](https://github.com/sarooo17/event-intelligence/pull/208).

It is intentionally independent of #208: the query is copied into the
**test-only profiling script**, and it runs against the currently shipped
`PostgresEventStore` schema. The profiler never changes the production
store implementation or the startup schema contract.

## Workload

- 1,000 and 10,000 stored **active** trigger definitions, evenly distributed
  over 20 distinct event names.
- Four extra definitions with lifecycle time-expiry/oneShot/maxFirings
  conditions on *unrelated* event names, to ensure the conservative query
  includes side-effect candidates.
- One deliberately mismatching `serverId` record and a matching record in
  a **different tenant scope**, both of which must be excluded.
- Compare the original `listTriggers`-style query, the PR #208
  source/event query without an index, and exactly the same selector after
  building a **temporary partial GIN** index with
  `(payload->'clauses') jsonb_path_ops WHERE kind='trigger'`.
- Run `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` with actual PostgreSQL
  planner metadata. Validate **identical returned candidate keys** before
  and after adding the index, not just counts.
- Emit exact commit, Node/PG versions, runner details, key counts and
  actual plan nodes; fail closed on mismatch and archive diagnostics.
- As a separate **query-design probe only**, compare the original single
  `OR` source/lifecycle query against a `UNION` of independently scoped
  source and lifecycle branches. Both query forms must return **identical
  sorted record keys**, pre/post disposable GIN creation. The UNION may
  permit source-branch indexing but also pays its own deduplication and
  lifecycle-branch scan costs; its planner selection is recorded, **not
  assumed**. This experimental branch is never wired into EI runtime.

The optional GIN index is built **only inside a randomly named disposable
benchmark table**, not as part of EI database startup and not in any
customer database. No durable schema version change, online migration,
concurrent installation or rollback is implied.

## Boundaries

This is a **query-plan and candidate-correctness investigation**, not a
full MCP network→Pattern→wake benchmark or a certified performance SLO.
The index can be ignored by PostgreSQL because the real query combines
JSONB containment with OR conditions for lifecycle exceptions. Whether
the planner actually uses GIN is recorded rather than asserted. Repeated
query execution warms caches and runners differ: observed single-run
latency changes are not sufficient grounds for deploying an index.

Do not merge #208 without an independent review; this evidence PR does
not resolve its review gate. If a physical index is genuinely beneficial,
create a separate migration PR with nonblocking `CREATE INDEX CONCURRENTLY`
on already populated databases, version/rollback design, write contention
tests, and independent approval. Never auto-create it under `init()` locks.

## Run locally against a disposable database

```sh
npm ci
npm install --no-save pg@8.16.3
npm run build
EI_PG_QUERY_PLAN_CONFIRM=YES_ISOLATED POSTGRES_URL='postgresql://...' \
  node scripts/evidence/postgres-source-query-plan.mjs \
  --triggers 1000 --sources 20 --samples 3
```

No release, downstream Muffin/Artemis changes, regex-policy changes, or
production schema changes are included. #47 remains open.
