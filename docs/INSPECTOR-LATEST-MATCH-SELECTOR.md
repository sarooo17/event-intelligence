# Latest match inspection: bounded result selection (#48)

An inspector call with a **specific trigger version** and no
`matchId` now prefers `getLatestTriggerMatch(triggerId,version)`
when the store implements this optional capability. PostgreSQL executes
one scope-local SQL `SELECT ... ORDER BY updatedAt DESC, status-rank
DESC, record_key ASC LIMIT 1` and deserializes **one current match**.
The order uses a `timestamptz` conversion **truncated to milliseconds**,
matching JavaScript `Date.parse` even with submillisecond fractions,
then applies the existing status-rank tie-breaker. It never assumes
lexical ISO timestamp sort. The JSONL reference store
selects by comparing current in-memory Map entries without
allocating an entire match array. Custom stores still use the
original `listTriggerMatches` fallback. A poisoned optional selector
may not return a match belonging to a different trigger or version.

This improves the Node response/memory cost for latest-match
selection, and builds on #322's scope-indexed exact ID path and
the existing bounded history/projection caps. It does **not** prove
server-side sublinear CPU/IO: PostgreSQL still filters/sorts all
matching records in the scoped kind using the current indexes, and
the JSONL reference selector is an in-memory linear pass. Nor does
it bound the sourceEvents JSON in one current match, derived event
reads, temporal deadline reads or output of a large patternState.
Operator-scale SLO and the full #48 cost acceptance remain OPEN
until those paths have strict limits and measured representative
resource usage.

Tests cover real PG16 with same-ID tenant collisions and two
different persisted timestamps, synthetic stores that throw if
unbounded list calls occur, and foreign selector results.
