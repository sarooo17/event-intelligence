# E48-A: separate-process MCP Events source and independent source-log oracle

**State: implementation candidate; E48-A NOT CERTIFIED.** This repository
now provides a small first-party independently running MCP Events SOURCE,
not another in-process `TriggerInspector` fixture. The source and its
independently executed oracle have different code paths, but the same
project/author and (until independently deployed) machine. This proves
software behavior under tests, **not** truthful completeness for an
arbitrary third-party provider or an external operator signoff.

## Files and trust boundaries

- `scripts/validation/standalone-mcp-source.mjs`: durable one-writer
  append-only JSONL record chain with actual file fsync, server-owned
  event timestamps, monotonic complete-through seals, idempotent event IDs,
  no source pruning, explicit revocation epoch transitions, limited
  replay and 120-second Ed25519 source attestations.
- `scripts/validation/run-standalone-mcp-source.mjs`: separate OS process
  exposing private JSON-RPC 2.0 `initialize`, `events/list`,
  `events/poll` at `POST /rpc`, plus authenticated operator-only
  `/control/append`, `/control/seal`, `/control/revocation`,
  `/frontier`, `/status`. Exposes unauthenticated `GET /health`
  without private event data. Only the embedding host may connect.
- `scripts/validation/standalone-mcp-source-oracle.mjs` independently
  verifies every record's sequence, chain digest, event time monotonicity,
  source revision, immutable source checkpoint, selected seal, canonical
  Ed25519 source claim, trusted public key and tenant/subscription binding.
  It does not call the provider's parser, retention logic or signer.
- `scripts/validation/verify-standalone-oracle-cli.mjs`: runs that
  oracle in its own OS process with a private input file and prints a
  **redacted** verdict (no raw events, tokens or signatures).
- `test/standalone-mcp-source.test.mjs`: actual separate source HTTP
  process + oracle child, unhealthy/unauthorized producer,
  signed/replayed/rotated key cases, exact scope/match identity,
  signed frontier revocation invalidation, idempotency, seal-time
  backdate denial, cold restart and hash-chain corruption rejection.
  No third-party provider or OpenAI API calls.

## Safe operator setup (requires credentials created outside Git)

Install Node 22+. Set these in a **private/isolated staging service**:

```text
EI_SOURCE_LOG_PATH=/data/mcp-source.jsonl
EI_SOURCE_CONTROL_TOKEN=<32+ byte private random secret>
EI_SOURCE_PRIVATE_KEY_PEM=<private Ed25519 PKCS8 PEM injected as secret>
EI_SOURCE_SCOPE_ID=fixture-tenant
EI_SOURCE_KEY_DIGEST=<64 lowercase hex SHA-256 trust-bound source key>
EI_SOURCE_CONNECTION_ID=source-connection
EI_SOURCE_SERVER_ID=source-service
EI_SOURCE_EVENT_NAME=sample.changed
EI_SOURCE_ARGUMENTS_CANONICAL={}
EI_SOURCE_BIND_HOST=0.0.0.0
```

Set Railway start command to:
`node scripts/validation/run-standalone-mcp-source.mjs`.
Set **one replica** and attach an isolated durable volume to `/data`.
Do not store the signer private key on that volume or in GitHub logs.
The file-log writer lock is exclusive; a true SIGKILL can leave a
**stale lock directory**, intentionally preventing blind restart. A
human operator must verify that the former writer is dead, preserve
the complete log and then clear only the stale writer lock; do not
auto-delete it or start another writer while the first is alive.

The endpoint is **not** a public unauthenticated MCP proxy. All controls
require a constant-time Bearer check; use private network access and
external transport-level compressed body, timeout, rate and IP limits.
The source code's 32 KiB decoded request guard is **not** a guarantee
about compressed bytes at a reverse proxy. The provider's own event
times are generated at durable append, never accepted from client
payloads. If wall-clock goes backwards, the source fails closed rather
than retroactively backdating older than a signed complete-through
seal. At a seal time T, new events must have event time greater than T.

### Smoke (operator-host controlled; never public)

```text
POST /rpc      {"jsonrpc":"2.0","id":1,"method":"initialize"}
POST /rpc      {"jsonrpc":"2.0","id":2,"method":"events/list"}
POST /control/append {"eventId":"test-1","data":{"value":1}}
POST /control/seal   {}
POST /rpc      {"jsonrpc":"2.0","id":3,"method":"events/poll","params":{"cursor":"source-v1:0","maxEvents":50}}
POST /frontier {"completenessRevision":1}
```

Use the real host's persisted source completeness revision in the
`/frontier` request. The source signs only a seal it has already durably
recorded; it cannot know an arbitrary host's revision. The EI
`persistExternallyAttestedFrontier` path must independently enforce
scope/revision/connection/source/arguments identity, current availability
and its own fail-closed source gap state. Do **not** set
`sourceCompletenessContractIndependentlyVerified:true` merely because
the source has signed a claim. A source signature authenticates *its*
statement, not business truth, external ingress delivery or host
ownership.

### Independent oracle evidence collection

Copy the **raw source log** to a separately retained, immutable
operator-controlled location and pin its SHA-256, plus exact source SHA,
deployed service/region, trusted public key fingerprint, signed
`/frontier` attestation (redacted securely), source head/sequence,
scope/source-key commitments and replay cursor observation.
Provide a private JSON input object to the oracle CLI containing
`{logPath,sourceLog,attestation,publicKeyPem,expected,now}`, where
`expected` binds scope, server, connection, event, sourceKeyDigest,
canonical arguments and the actual host revision. The oracle re-opens
the full file with independent reader/validator; do not use a
same-process helper as the only purported independent witness.

**Do not publish** raw source events, secret identity values, private
keys, bearer token, customer tenant data or private failure payloads.
Store only redacted digests and reproducible configurations in GitHub
issue [#376](https://github.com/sarooo17/event-intelligence/issues/376).

## What remains before marking E48-A checked

1. Review/merge the PR on exact HEAD with full CI and negative tests.
2. **Deploy the stand-alone service** to Railway staging with isolated
   durability, private secrets and independently pinned source SHA.
3. Send real MCP Events from it to a separately running EI-host consumer
   and inspect stored PG16 source/trigger/receipt evidence. Validate
   `candidate_impossible` only under a fully reviewed source contract.
4. Execute fault matrix: healthy, delayed/reordered, missing, stale
   cursor, `truncated`, source outage, duplicate/replayed ID,
   backdated request denial, old/rotated signer, revocation/epoch
   mismatch and source-log tampering; compare independent oracle,
   EI PG16 evidence and host durable receipt counts.
5. Pin raw artifacts, external service config and reviewer verdict.
   Record gaps honestly as **UNKNOWN**. A first-party operator is
   allowed for this separate-source conformance, but this does **not**
   substitute for #317 independent human deployed-host signoff.

Until all five are done, **#376 E48-A remains unchecked**. No
provider-specific guarantees are inserted into the generic EI core.
