# Canonical operation output contracts — phase 1

Tracking #43. This slice models the **shared semantic result core** of the first two read operations: `event_sources_list` and `trigger_list`.

Both the embedded host-facing descriptors and standalone MCP `tools/list` expose validated output schemas for these operations, derived from one Zod output contract library. Both execution paths check results before handing them to the model/host response projection. The validator returns original values unchanged: untrusted evidence is **not** normalized into privileges, and host result projection remains host-owned.

| Operation | Shared fields | Intentional difference |
| --- | --- | --- |
| event_sources_list | `sources` array | Embedded sources are compact host-neutral summaries, MCP may return richer provider information |
| trigger_list | `triggers` array | Embedded additionally requires nonnegative `total` and `returned`; MCP continues returning full owner-scoped records |

`OPERATION_OUTPUT_CONTRACT_VERSION='1'` versions only this minimal output contract, not the overall Event Intelligence protocol. The schemas use permissive nested records deliberately: fully constraining provider payloads, event evidence, match lineage and runtime-specific projectResult references would be misleading and may leak/strip information unexpectedly.

**Not modeled yet:** `trigger_inspect`, `trigger_create`, `trigger_pause`, `trigger_resume`, `trigger_delete`, `trigger_update`, `trigger_plan`, `trigger_simulate`, `trigger_language_describe`, `derived_contracts_list`, `wake_hydrate`, `runtime_status`. These operations retain their existing wire responses, and **no output schema is advertised** for them. Full cross-surface output equivalence is not claimed. No legacy compatibility shims are added; hosts already customize inline/reference output with `projectResult`.

Validation does not grant authority: MCP ownership checks and embedded `resolveContext/control` occur separately before response generation. Untrusted MCP producer data must remain untrusted across host activation.

**Inspector exception:** A host may supply a customized `triggerInspector.inspect()` returning a different valid host-owned shape. CI exposed that assumption when a reference host returned `{triggerId, version, explanation}` instead of EI's built-in rich inspector object. Do not impose an output validator on that path until a canonical host inspector contract is explicitly defined and versioned.
