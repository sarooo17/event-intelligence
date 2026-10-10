# Canonical operation output contracts — incremental coverage

Tracking #43. The first slice models the **shared semantic result core** of two read operations: `event_sources_list` and `trigger_list`. The next slice adds a **stdio-only** output contract for the canonical `trigger_plan` result.

Both the embedded host-facing descriptors and standalone MCP `tools/list` expose validated output schemas for shared operations; stdio alone advertises the `trigger_plan` schema. All modeled outputs are derived from one Zod output contract library. Both execution paths check results before handing them to the model/host response projection. The validator returns original values unchanged: untrusted evidence is **not** normalized into privileges, and host result projection remains host-owned.

| Operation | Shared fields | Intentional difference |
| --- | --- | --- |
| event_sources_list | `sources` array | Embedded sources are compact host-neutral summaries, MCP may return richer provider information |
| trigger_list | `triggers` array | Embedded additionally requires nonnegative `total` and `returned`; MCP continues returning full owner-scoped records |
| trigger_plan | `planVersion: '2'`, `definition`, `connectionIds`, `resolvedSources`, `warnings`, `explanation.when/then` | Stdio only. Embedded callers use a scoped `planTrigger()` method and have no `trigger_plan` model tool |
| trigger_language_describe | Version 3 with declared canonical authoring surface and planner | Stdio-only; optional categories are preserved without fabricating fields |
| derived_contracts_list | `contracts` array | Stdio-only, nested provider-owned schemas remain opaque/untrusted |
| runtime_status | Connection list, counts, enabled-write flag and restore metadata | Stdio-only, status is operational telemetry, not an authorization claim |

`OPERATION_OUTPUT_CONTRACT_VERSION='1'` versions only this minimal output contract, not the overall Event Intelligence protocol. The schemas use permissive nested records deliberately: fully constraining provider payloads, event evidence, match lineage and runtime-specific projectResult references would be misleading and may leak/strip information unexpectedly.

**Not modeled yet:** `trigger_inspect`, `trigger_create`, `trigger_pause`, `trigger_resume`, `trigger_delete`, `trigger_update`, `trigger_simulate`, `wake_hydrate`. These operations retain their existing wire responses, and **no output schema is advertised** for them. Full cross-surface output equivalence is not claimed. No legacy compatibility shims are added; hosts already customize inline/reference output with `projectResult`.

Validation does not grant authority: MCP ownership checks and embedded `resolveContext/control` occur separately before response generation. Untrusted MCP producer data must remain untrusted across host activation.

**Inspector exception:** A host may supply a customized `triggerInspector.inspect()` returning a different valid host-owned shape. CI exposed that assumption when a reference host returned `{triggerId, version, explanation}` instead of EI's built-in rich inspector object. Do not impose an output validator on that path until a canonical host inspector contract is explicitly defined and versioned.
