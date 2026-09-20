# Security Model

## Trust boundaries

Event Intelligence sits between event producers and agent runtimes. The main trust boundaries are:

1. provider / MCP event source → Event Intelligence;
2. user or agent → trigger control plane;
3. Event Intelligence → runtime callback;
4. persistent store / audit evidence.

## Ingress

Provider-specific ingress should authenticate at the provider boundary. The GitHub adapter verifies the webhook signature when configured.

For MCP Events ingress, the embedding host retains the MCP transport, authorization context and provider credentials. Event Intelligence enumerates the host-provided MCP registry and reuses only Events-capable client objects. It does not copy or persist provider OAuth tokens, API keys or connection URLs.

Event IDs are deduplicated before they can become a second logical source occurrence.

## Trigger authority

A trigger may only reference active event sources available in its declared connection scope.

Agent-authored persistent mutations require a confirmation identifier. The existing agent authors a structured trigger; the deterministic control plane validates it before persistence.

Source scope and advertised predicate/correlation/projection paths fail closed when the source provides a payload schema.

## Derived events

Derived event payloads are not arbitrary copies of parent payloads.

Only explicitly configured scalar projections and constants enter the new event. Lineage stores refs/hashes instead of raw parent payloads.

Contract fingerprints prevent same-version producers from silently changing the derived-event shape.

## Runtime wake

In embedded mode, the harness normally supplies one in-process wake dispatcher and routes by the validated trigger target; runtime-specific handlers are an optional lower-level path. Trigger authors cannot create arbitrary handlers or callback endpoints.

Standalone deployments may use operator-configured remote callbacks. Those targets must use HTTPS (except local development) and shared secrets must meet the implementation's minimum length.

Remote wake requests are HMAC-signed over canonical packet content and a timestamp. Runtime receipts are persisted and stable wake IDs make replay idempotent in the validated scenarios.

## Persistence and audit

The JSONL store is single-writer reference infrastructure.

The audit stream is hash-linked. This makes local tampering detectable when verification is run, but the same process controls the files; therefore it is not an immutable audit system.

Production hardening should use:

- transactional storage / outbox;
- external retained audit sink;
- secret manager;
- multi-tenant authorization boundaries;
- rate limiting at the deployment edge;
- backup / restore testing.

## AI boundary

Event Intelligence does not contain a general-purpose agent or natural-language planner. The surrounding harness/agent performs reasoning and submits structured trigger definitions.

The only bundled AI adapter is the optional TypeSafe Jev semantic evaluator, used when a trigger explicitly requests semantic correlation. A model cannot gain authority by inventing an event source, field, runtime target or contract version because the deterministic control plane validates the submitted program.
