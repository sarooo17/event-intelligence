# Externally signed source frontier — acceptance #48, **partial evidence**

## Why an MCP Events replay cursor is insufficient

The MCP Events experimental design sketch treats `cursor` as an opaque
*stream position*, not an event-time watermark. It explicitly allows
non-replayable sources (`cursor:null`) and `truncated:true` after missed
history. An untruncated cursor can prove only what the provider's own
stream contract promises, not that **no event whose event timestamp is
older than T can still arrive**. Never convert cursor, heartbeat,
`maxObservedOccurredAt`, or `nextPollMs` into the EI
`candidate_impossible` diagnosis.

Relevant published concrete sources and limitations (verified
2026-10-30):
- Bird MCP Events: its documented `amb.received` event integration returns
  `cursor:null` and keeps no replay history. It cannot act as an
  authoritative complete-through watermark source.
- MCPG Gateway: documents replay from a durable cursor and
  `truncated:true` for stale history. This is useful for **gap recovery**,
  but its public MCP Events contract does not itself certify complete
  historical delivery *by event-time T*.
- The MCP Events design sketch: replay is optional and reliable ordered
  delivery is not mandated. A provider-specific finality contract is
  mandatory to infer a terminal selected candidate.

See:
https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md
https://bird.com/docs/ai/mcp-events
https://mcpg.dev/docs/gateway/mcp-events

## Additive, provider-neutral signed attestation contract

A source that **does** guarantee no missing or backdated event-time
occurrences before a stated frontier may sign a short-lived
`ei.external-source-frontier-claim.v1` Ed25519 attestation, using a trusted
source key configured by the *host*. The signed object binds:

- exact host tenant scope **digest**
- exact MCP source-key and canonical subscription-argument digests
- connection/server/event identities and source completeness revision
- `completeThroughAt` (UTC millisecond ISO timestamp)
- independently inspected and agreed
  `monotonic-event-time-complete-through-v1` provider policy
- bounded issue/expiry time, max 5 minutes

`createExternalSourceFrontierVerifier` checks canonical serialized
message bytes, authentic Ed25519 provider signature and all the host
context. `persistExternallyAttestedFrontier` passes that verifier into
the existing PostgreSQL transaction-fenced
`recordVerifiedInspectionFrontier` (PR #343). No provider private key,
event payload, actual signature, raw subscription arguments or full
attestation is stored in EI's durable source record — only a proof digest,
identity digests, revision and timestamp.

A host must set
`sourceCompletenessContractIndependentlyVerified:true` **only after**
independently checking the provider's event-time assignment, backfill
policy, replay, gaps, retention, output authenticity and key ownership.
The cryptographic signature proves **who signed the claim**, not that the
source's business semantics were truthful. A dishonest or faulty provider
can sign a false watermark. Thus signature validity alone is **not**
a third-party correctness certification.

Any failed signature, unexpected source/tenant/arguments, expired proof,
stale revision, gap, availability failure or provider with no event-time
guarantee MUST result in no terminal-candidate proof. No generic MCP
event.data field is elevated to authority. The current host must opt in;
none of the EI core semantics become provider-specific.

## Test/evidence and outstanding external work

`test/mcp-source-frontier-attestation.test.mjs` generates an independent
Ed25519 test provider, verifies issuer/TTL/source/tenant/args negative
cases and, on real PostgreSQL 16, persists an authenticated source frontier,
then simulates a new poll revision to invalidate it. This is still a
*test signer*, not a third-party source.

To close #48 acceptance #1, choose a REAL external provider that
independently documents/attests its no-backdating event-time frontier;
verify real delivery, replay gaps/truncation, source outage, signed
frontier, stale revisions and selected candidate finality against actual
history. An ordinary cursor-only provider cannot fulfill this requirement.
To close #48 acceptance #5, independently gather representative
full-inspector CPU/IO/latency under actual host load, not just synthetic
CI and a single short Railway microprofile.

**Do not check either remaining acceptance simply because this adapter
and its test signer merge.**
