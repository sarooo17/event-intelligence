# Canonical operation output contracts — v1 preparation

Tracking #43. `OPERATION_OUTPUT_CONTRACT_VERSION='1'` versions the
operation result schemas, **not** the overall EI protocol or its npm API.

## Two projections, one control plane

Both the embedded host-facing tool descriptors and the optional standalone
MCP stdio `tools/list` advertise Zod-generated JSON output schemas where
their native result shapes are deterministic. The operation manifest owns
names/authority metadata; `operation-output-contracts.mjs` validates the
surface-specific result before handing it to its presentation layer. It returns
the original object unchanged and never authorizes a mutation or promotes
external event evidence to trusted instructions.

| Operation | Embedded output | Optional stdio MCP output |
| --- | --- | --- |
| `event_sources_list` | Compact `sources` array | Rich `sources` array |
| `trigger_list` | `triggers`, `total`, `returned` | Rich owner-scoped `triggers` array |
| `trigger_create` | Receipt ID, trigger ID/version, active state, connection IDs and warnings | Canonical definition, state, action, receipt and optional planning result |
| `trigger_pause`, `trigger_resume`, `trigger_delete` | Receipt, action, trigger ID/version and corresponding lifecycle state | Canonical definition, action/state and receipt |
| `trigger_update` | Receipt, action, trigger ID, previous/new versions, active state, connection IDs and warnings | Canonical new and previous definition/state and receipt |
| `trigger_plan` | Not exposed as a model tool; scoped `planTrigger()` is available | Versioned planner result |
| `trigger_inspect` | Host-customizable result: no universally advertised schema | Versioned EI inspector envelope |
| `trigger_simulate`, `wake_hydrate`, `trigger_language_describe`, `derived_contracts_list`, `runtime_status` | Not exposed as model-facing embedded tools | Validated operation-specific envelopes |

The **compact embedded mutation projection** is intentionally not the
stdio output. It does not expose an entire stored trigger definition or host
principal context. JSON schemas require nonempty durable receipt/identity
fields, an operation-appropriate lifecycle status, and relevant version,
connection and warning fields. These checks execute on the native result
before any host-supplied `projectResult()`; host model projection and
authorization remain host-owned.

## Durable commit and presentation failure

EI commits the trigger mutation through the host-authorized control plane
*before* constructing a compact response. A presentation/validation exception
after that commit cannot turn the operation into an apparent failed mutation:
the adapter retains its existing `ok:true` canonical inline fallback so
callers do not retry a committed write. The output contract is separately
enforceable through `validateOperationOutput()` and tested against shape drift.
It does **not** claim a malformed custom host control-plane result was rolled
back or that the fallback was revalidated after failure. Such a host violates
the documented embedded contract and must be fixed at its boundary.

For the same reason the embedded `trigger_inspect` operation does not
advertise stdio's rich inspector schema: third-party hosts may intentionally
supply another shape. A versioned inspector host contract and complete
cross-surface input/output projection parity remain work under #43.
No legacy host shims, extra policy layer, scheduler, runtime SDK or model
dependency are added.
