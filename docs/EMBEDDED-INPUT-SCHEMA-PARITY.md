# Embedded tool input schema — single source of truth

Tracking [#43](https://github.com/sarooo17/event-intelligence/issues/43).

The eight embedded management tools now derive their advertised JSON Schema **directly from the exact Zod validators** that parse host tool arguments. The implementation lives in `scripts/lib/embedded-operation-schemas.mjs`, with both `EMBEDDED_INPUT_VALIDATORS` and `EMBEDDED_INPUT_JSON_SCHEMAS` indexed by the keys in `OPERATION_MANIFEST`.

The embedded tool registry still exposes immutable descriptors; the existing deep-freeze guarantees apply to generated nested schemas. A change to max clause counts, argument shapes, required fields, date-time validation or lifecycle inputs automatically changes the public tool schema. No second hand-maintained JSON schema is required.

```sh
npm test
node --test test/embedded-schema-parity.test.mjs
```

The regression test verifies all eight validators/descriptors, nested bounds, required fields, strict extra-property policy, and that lifecycle operations reject model-supplied owner/tenant fields. Host authority remains with `resolveContext()` and `control()`; JSON Schema visibility is **not** authorization.

## Compatibility and boundaries

This pre-v1 refactor intentionally changes the serialization details of embedded tool descriptors (for example, generated `format: date-time` and Zod's choice of JSON Schema union representation) while preserving the **runtime Zod input acceptance** and all existing operation names and capability IDs.

Consumers comparing schemas byte-for-byte should regenerate their tools. The standalone MCP stdio input projection stays separately canonical in `scripts/lib/mcp-operation-schemas.mjs`; it is deliberately not identical to the embedded compact authoring syntax. Full cross-surface projection mapping and versioned output contracts remain open in #43.

No compatibility shim, alternate Pattern AST, new policy engine, npm publish, or consumer repo updates.
