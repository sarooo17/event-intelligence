# Standalone MCP input-schema registry

Tracking [#43](https://github.com/sarooo17/event-intelligence/issues/43).

The standalone stdio server's 14 public tool input validators are defined in
`scripts/lib/mcp-operation-schemas.mjs` as the immutable
`MCP_OPERATION_SCHEMAS` mapping, indexed by the canonical operation keys from
`OPERATION_MANIFEST`. The actual `McpServer.registerTool()` path consumes
those same Zod instances. No extra schema compiler or parsing layer is introduced.

The tests verify:

- exactly one Zod schema for each of the 14 canonical operations;
- strict, owner-scoped `trigger_list` has **no** `ownerOnly` opt-out;
- every mutation includes a required `confirmationId` field;
- pause/resume/delete share one lifecycle input contract;
- live MCP stdio `tools/list` advertises the same argument field names and
  required fields as the canonical Zod validators, in both read-only and
  write-enabled modes.

```bash
npm run test
node --test test/mcp-operation-schemas.test.mjs
node --test test/mcp-stdio-server.test.mjs
```

**Compatibility and limits:** No standalone MCP wire input shapes are
intentionally changed. Embedded uses a different, compact host-neutral
authoring schema and remains separate. This is a **canonical stdio
projection**, not yet one uniform input/output schema shared between stdio,
embedded, service and CLI. No new permissions are granted; the host and MCP
control plane remain responsible for identity/authorization and per-action
approval. The broader normalized cross-surface schema issue stays open.
