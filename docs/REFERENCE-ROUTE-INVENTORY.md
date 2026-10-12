# Reference HTTP / CLI operation inventory (non-model surfaces)

Completes the non-model-operation inventory requested by #43. These
endpoints are **not** additional agent tools and are not covered by the
canonical embedded/MCP model-tool JSON output schemas. See
[OPERATION-CATALOG-AUDIT.md](./OPERATION-CATALOG-AUDIT.md) for the canonical
14 model operations. This document is checked against the HTTP service's
actual route conditions in CI.

The HTTP service (`scripts/service.mjs`) is a **single-operator reference
service**, not a general-purpose multi-user API. Unless noted, `/v1/*`
requires `SERVICE_AUTH_TOKEN` as a bearer token. Some control routes accept
actor/owner inputs in their JSON body; that reference trust boundary is
**not** equivalent to the embedded host's principal-based authorization
and must not be exposed to untrusted model callers. Query parameters,
request bodies and responses below are *route summaries*, not a claim of
one shared JSON Schema or an externally audited REST contract.

| HTTP route | Input / output summary | Auth and effect |
| --- | --- | --- |
| `GET /healthz` | None → protocol and schema version / status | Public health read |
| `GET /readyz` | None → audit, source and scheduler readiness counts | Public readiness read |
| `POST /v1/providers/github/webhook` | GitHub signed body → accepted/ignored event receipt | GitHub HMAC, event ingest |
| `POST /mcp` | MCP JSON-RPC Events request → MCP JSON-RPC response | Bearer, MCP producer transport |
| `GET /v1/derived-contracts` | eventName query → contracts | Bearer, runtime read |
| `GET /v1/derived-events` | triggerId query → derived events | Bearer, runtime read |
| `GET /v1/inspector/triggers/{id}` | trigger/version/match selectors → inspection | Bearer, inspector read |
| `POST /v1/inspector/simulate` | definition/events and clock controls → isolated simulation | Bearer, isolated evaluation |
| `GET /v1/temporal/deadlines` | trigger and deadline filters → deadline list | Bearer, scheduler read |
| `POST /v1/temporal/deadlines/run-due` | None → due evaluation outcomes | Bearer, scheduler effects |
| `GET /v1/event-sources` | connectionId filters → source catalog | Bearer, source read |
| `POST /v1/event-sources` | source and actor → registered source | Bearer, source mutation |
| `GET /v1/control/triggers` | owner/tenant selectors → trigger entries | Bearer, control read |
| `PATCH /v1/control/triggers/{id}` | definition/expected version, actor/owner/confirmation → mutation receipt | Bearer, durable update |
| `DELETE /v1/control/triggers/{id}` | version/actor/owner/confirmation → mutation receipt | Bearer, durable delete |
| `POST /v1/control/triggers` | definition/connections, actor/owner/confirmation → receipt | Bearer, durable create |
| `POST /v1/control/triggers/{id}/pause` | version/actor/owner/confirmation → receipt | Bearer, durable pause |
| `POST /v1/control/triggers/{id}/resume` | version/actor/owner/confirmation → receipt | Bearer, durable resume |
| `POST /v1/triggers` | canonical definition → registered Pattern trigger | Bearer, reference registration |
| `GET /v1/triggers` | None → trigger definitions | Bearer, runtime read |
| `GET /v1/trigger-matches` | triggerId query → match records | Bearer, runtime read |
| `POST /v1/composite/events/ingest` | correlatable event → match results and wake deliveries | Bearer, event ingest and wake |
| `POST /v1/trigger-matches/{id}/fire` | matchId / delivery input → dispatch result | Bearer, wake delivery |
| `GET /v1/protocol` | None → version/profile compatibility | Bearer, protocol read |
| `GET /v1/audit` | traceId/afterSequence → audit and chain verification | Bearer, audit read |
| `GET /v1/traces/{id}` | traceId → matching trace | Bearer, trace read |

The reference service has overlapping underlying capabilities with
`trigger_create`, `trigger_inspect` and other embedded/MCP tools, but it is
*not* a new trigger language: these handlers delegate to the existing
`TriggerControlPlane`, `TriggerInspector`, `CompositeTriggerEngine`,
`CompositeEventConsumer` and store. No HTTP endpoints are registered into
the model-visible canonical catalog. A production remote multi-user service
requires its own authentication/authorization, rate limits and full REST
schema contract; #45 and #50 still track that broader security/release work.

## CLI entrypoints

| CLI invocation | Meaning | Model-facing operation? |
| --- | --- | --- |
| `mcp-event-intelligence` | Start single-operator HTTP reference service | No |
| `mcp-event-intelligence mcp` or `--mcp` | Start optional stdio MCP adapter (canonical 14-op manifest, writes opt-in) | No new operation |
| `mcp-event-intelligence doctor` (`--json` optional) | Local, read-only integration diagnostics | No |
| `mcp-event-intelligence --version` or `-v` | Installed package version | No |
| `mcp-event-intelligence --help` or `-h` | Command help | No |

The lower-level exported `/host`, `/provider`, `/embedded`,
`/conformance`, `/diagnostics` and `/storage/postgres` libraries
also are not a model-facing operation. They are typed public programming
interfaces used by the host/provider. Their access control and runtime
effects are not inferred from model-visible tool metadata.

**Parity check:** `test/reference-route-inventory.test.mjs` reads real
service JavaScript route conditions and rejects undocumented/missing
HTTP method+path entries. CLI entrypoint modes are likewise asserted against
the implemented dispatcher. This is a static boundary/inventory gate,
not an HTTP OpenAPI conformance or a runtime identity penetration test.
