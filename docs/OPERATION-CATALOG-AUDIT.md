# Canonical model-operation catalog audit — v1 pre-release

Tracked by #43 and executable completeness gate #121. The **model-facing**
tools are precisely the 14 optional standalone MCP stdio operations and the
8 embedded, host-neutral management operations declared in
`scripts/lib/operation-manifest.mjs` (`OPERATION_MANIFEST_VERSION=1`).

The manifest is authoritative for the operation ID, public name, resource,
scope, effect/durability, host-control requirement and supported surfaces.
Inputs are schema-validated surface projections; outputs are independently
versioned in `operation-output-contracts.mjs`. A shared Pattern AST and
TriggerControlPlane remain responsible for execution; this does not create
another trigger engine, scheduler or authorization layer.

| Canonical operation | Embedded | MCP stdio | Authorization scope |
| --- | --- | --- | --- |
| `event_sources_list` | Yes | Yes | host source registry |
| `trigger_plan` | No | Yes | host source registry |
| `trigger_language_describe` | No | Yes | public grammar |
| `trigger_create` | Yes | Optional write | owner |
| `trigger_list` | Yes | Yes | owner |
| `trigger_inspect` | Yes | Yes | owner |
| `trigger_pause` | Yes | Optional write | owner |
| `trigger_resume` | Yes | Optional write | owner |
| `trigger_delete` | Yes | Optional write | owner |
| `trigger_update` | Yes | Optional write | owner |
| `trigger_simulate` | No | Yes | host-supplied isolated input |
| `derived_contracts_list` | No | Yes | operator/runtime |
| `wake_hydrate` | No | Yes | owner |
| `runtime_status` | No | Yes | operator/runtime |

All 14 stdio operations have actual JSON input/output schema projection
checks exercised by a real MCP stdio client in CI, and all 8 embedded
operations have input schemas generated directly from their Zod execution
validators. Seven embedded results use native Zod output schemas. Embedded
write result envelopes are compact receipt/status/identity projections,
deliberately different from the richer stdio ones.

## Deliberate output omission

`embedded.trigger_inspect` is the **only** exposed model-tool output schema
omission. Embedded hosts may install their own `triggerInspector.inspect()`
with a host-specific response shape; the library cannot truthfully advertise
stdio's rich canonical Inspector envelope. A caller can explicitly use the
canonical inspector in its host, but runtime-generated tool metadata must not
promise that shape for every host. The exception is machine-readable in
`OUTPUT_CONTRACT_EXCEPTIONS.embedded.inspect` and audited by CI.
This is a documented contract exception, not an authorization exemption:
owner-scoped trigger selection precedes inspection.

Embedded tools are registered **only when** an embedding host opts into
model-facing tooling with its own `resolveContext()`, `control()` and tool
adaptor/registration. Filtered exposure happens before host tool
registration; `operationNamesForSurface(surface,{allowMutations:false})`
excludes every persistent mutation. The optional MCP stdio mode registers
read-only operations unless the operator sets `MCP_WRITE_ENABLED=true`.
Even then every mutation requires `confirmationId` and passes through
the real TriggerControlPlane and its owner/source validation.

**No model argument may supply owner, actor, credential, tenant identity or
host authorization** through embedded management schemas. In stdio the
owner/actor are operator configuration, not model arguments; the stdio
session is intended for a configured owner, not unauthenticated multi-user
remote access. Hosts still own actual principal policy, approval interrupts,
credential lifetime, dynamic search/preload and post-wake tool permissions.

## Explicit non-model operation inventory

The bundled **HTTP reference service** (`scripts/service.mjs`) has operational
REST routes and a producer-side MCP endpoint; they are **not a model-facing
operation** projection and must not be silently registered as agent tools.
Examples include `/healthz`, `/readyz`, `/mcp`, provider webhook ingress,
derived-contract/event introspection, control-trigger endpoints,
inspector/simulator routes, temporal deadline operations and audit/trace
reads. The service has its own authentication and HTTP argument/response
contracts, not automatically the owner-scoped stdio or embedded model
identity. Refactoring the HTTP reference service into a general multi-user
API is not implied by model-tool catalog parity.

The binary **CLI** (`bin/mcp-event-intelligence.mjs`) chooses the reference
HTTP service, optional `mcp` stdio mode, or offline read-only `doctor`
configuration diagnostics; `--help`/`--version` are local information
commands. These modes are not additional Event Intelligence model operations.
The CLI's `mcp` mode delegates to the same stdio registration enumerated
above; `doctor` is not a model-facing operation.

Lower-level public `/host`, `/provider`, `/embedded`, `/storage/postgres`
and `/conformance` exports expose advanced host/provider/store contracts,
not additional model-tool dispatchers. They retain their own typed authority
and storage boundaries.

## Executable closure evidence

- `test/operation-catalog-completeness.test.mjs`: complete manifest/input/
  output/scope inventory, explicit omissions and runtime-neutral embedded
  metadata; missing schema/authority keys and unexpected omissions fail CI.
- `test/mcp-stdio-server.test.mjs`: **actual** SDK tool discovery in read-only
  and operator-write configurations; complete exposed input/output schemas,
  owner-protected read behavior and mutation source-authorization checks.
- `test/embedded-schema-parity.test.mjs`,
  `test/operation-output-contracts.test.mjs`, and
  `test/embedded-host-kit.test.mjs`: same validator execution paths, post-
  commit receipt handling, host approvals, negative owner cross-scope tests.
- `test/operation-manifest.test.mjs`: immutable metadata, unique names/IDs,
  read-only capability projections.

These checks certify **model-tool operation catalog parity** and documented
non-model surfaces, not universal automatic compatibility with proprietary
hosts or a replacement for cross-tenant security and runtime conformance
work under #42/#45/#50. Pre-v1 native projections may deliberately diverge;
there are no compatibility aliases or runtime-name switches.
