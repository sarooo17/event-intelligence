# E48-A — real MCP HTTP fault-injection and private raw evidence (2026-11-01)

**Scope**: the privately deployed, explicitly first-party E48 test source in Railway
`ei-validation/staging`. This does NOT independently certify external business
sources, E47 production HA/RPO/RTO, or the separately maintained host required by #317.

## Live, host-observed TCP failure, not just a JS stub

`scripts/validation/live-e48-http-faults-once.mjs` runs on a separate Railway
one-shot service. It talks to the **actual** durable Ed25519-signed MCP Events
provider over Railway private DNS, then listens on an actual loopback TCP
socket as a faulting MCP HTTP gateway. The test client performs real
`fetch()` HTTP requests across this socket, never directly fabricates a
poll response inside the consumer path.

| Transport fault | Live observation | Interpretation |
| --- | --- | --- |
| Healthy | Real source `events/poll` forwarded byte-for-byte | Verify occurrences and independent archive oracle |
| Reordered | Proxy physically reverses real events in an HTTP response | Consumer must not mistake cursor/event time for unconditional completeness |
| Missing | Proxy physically drops real events from the HTTP response; original provider log and oracle prove they exist | Delivery gap may be hidden by an untruthful transport; never assume terminal absence |
| Truncated | Proxy sends real `truncated:true` over HTTP, and host records it in actual shared PostgreSQL 16 MCP state | `TriggerInspector.inspect()` MUST report `source_gap_unresolved` and no `candidate_impossible` |
| Disconnected | Proxy physically destroys its TCP connection before replying | Actual host fetch fails; PostgreSQL source marked unavailable; inspection MUST NOT certify terminal absence |
| Timeout | Proxy delays its HTTP response past host AbortSignal deadline | Actual timeout, still UNKNOWN; this is **not** a provider-side billing/cancel proof |

The honest provenance of these cases is **intentional network fault injection**.
The upstream source process itself is not crashed or restarted. These are
genuine failed/malformed/late TCP/HTTP deliveries to the host, but **not
independent provider production outages**.

## Artifact preservation

The runner requires a private mounted persistent storage directory set in
`EI_E48_PRIVATE_EVIDENCE_DIR`, disallows a success report unless it
persists:

- the **exact original full source JSONL log bytes** (not reconstructed
  event data), with source SHA-256 matching the provider's operator export;
- sanitized PostgreSQL MCP source revision/availability/gap state,
  result from the real inspector, source/claim digests, tested failure
  cases and source exact commit;
- a final explicit `fsync` of both evidence files and evidence directory.

Files are mode 0600 on a private directory 0700. They do **not** include
source signing keys, bearer tokens, provider usage bills, customer records
or raw signed attestation. The artifacts are retained **off the source
volume** in the validation runner's isolated Railway volume. This is a
private reproducibility archive but does **not** imply an immutable WORM
archive or signed independent organizational provenance.

## Certification mapping

This completes genuine MCP HTTP transport fault evidence, unavailable
source refusal, known-missing source vs consumer view, truncation and
reordering, plus the already observed real first-party source
revocation/key-rotation-oracle/tenant/revision checks and the separately
deployed source → PG16 signed `candidate_impossible` witness in PR #386.

Do not mark #317 security, #376 E47-A/B/C, E48-B or E49-A/B as
certified by this run. Source completeness truth is demonstrated only
for the **first-party, measured monotonic event-time source contract**,
not arbitrary MCP Events providers. The user/operator must retain the
private evidence volume; never attach the raw archive to a public issue.
