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

A trigger may only reference active event sources available in its scoped connection set.

Agent-authored persistent mutations require a confirmation identifier. For common cases, the surrounding agent can submit an agent-friendly plan to `trigger_plan` / `planTrigger()`; Event Intelligence deterministically resolves live sources, validates advertised fields, and compiles the canonical trigger definition before persistence. Advanced callers may still submit canonical definitions directly.

Planning does not grant authority. Source scope and advertised predicate/correlation/projection paths fail closed when the source provides a payload schema. The embedding host remains responsible for deciding which user/agent may create or mutate triggers.

## Derived events

Derived event payloads are not arbitrary copies of parent payloads.

Only explicitly configured scalar projections and constants enter the new event. Lineage stores refs/hashes instead of raw parent payloads.

Contract fingerprints prevent same-version producers from silently changing the derived-event shape.

## Runtime wake

In embedded mode, the harness normally supplies one in-process wake dispatcher and routes by the validated trigger target; runtime-specific handlers are an optional lower-level path. Trigger authors cannot create arbitrary handlers or callback endpoints.

The wire wake remains reference-only. Embedded callbacks may additionally receive a hydrated Activation Envelope containing the persisted continuation plus matched evidence. The envelope labels the continuation as configured trigger instruction and event evidence as untrusted external signal data. Hosts must not treat event payload contents as instructions or as new authorization.

Standalone deployments may use operator-configured remote callbacks. Those targets must use HTTPS (except local development) and shared secrets must meet the implementation's minimum length.

Remote wake requests are HMAC-signed over canonical packet content and a timestamp. Runtime receipts are persisted and stable wake IDs make replay idempotent in the validated scenarios.

## Persistence and audit

The JSONL store is single-writer reference infrastructure.

The audit stream is hash-linked. This makes local tampering detectable when verification is run, but the same process controls the files; therefore it is not an immutable audit system.

The bundled store physically partitions non-default scopes and serializes writes within one process. The trusted root host can enumerate scopes; tenant-facing callers should receive only `host.scope(scopeId)`.

Production hardening should use:

- transactional storage / outbox for horizontally scaled deployments;
- atomic cross-process wake claim/lease operations in custom stores;
- external retained audit sink;
- secret manager;
- host-level tenant/user authorization in front of scoped capabilities;
- rate limiting at the deployment edge;
- backup / restore testing.

## AI boundary

Event Intelligence does not contain a general-purpose agent or natural-language model planner. The surrounding harness/agent performs natural-language reasoning. Event Intelligence can then deterministically compile an agent-friendly trigger plan into the canonical trigger program.

The only bundled AI adapter is the optional TypeSafe Jev semantic evaluator, used when a trigger explicitly requests semantic correlation. A model cannot gain authority by inventing an event source, field, runtime target or contract version because the deterministic control plane validates the submitted program against scoped live sources and schemas.
