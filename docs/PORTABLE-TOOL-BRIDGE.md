# Portable tool descriptor bridge (issue #270)

This is an **experimental, optional** ergonomic helper for tool-enabled
consumers. It does not add a new event engine, authorization engine, result
format, SDK-specific adapter or alternate binding/registration API.

`createPortableToolAdapter({makeTool})` turns an existing EI
`PortableAgentTool` into a descriptor with `name`, `description`,
`inputSchema`, optional `outputSchema`, canonical `capability`, and an
`execute(args,context)` function. A consumer decides how to turn the
descriptor into any native tool ABI.

```js
import {
  createPortableToolAdapter,
  createEventIntelligence,
} from 'mcp-event-intelligence/embedded';

const integration = await createEventIntelligence({
  runtime: {
    deliver: host.deliver,
    resolveContext: host.resolveContext,
    control: host.control, // mandatory alongside resolveContext; host-owned
  },
});

const adapt = createPortableToolAdapter({
  makeTool: view => ({
    spec: { name: view.name, description: view.description, inputSchema: view.inputSchema },
    handle: (args, ctx) => view.execute(args, ctx),
  }),
});

integration.bind({
  adapt,
  register: tool => host.registerTool(tool),
  capabilityIds: await host.exposedCapabilityIds(),
  onClose: hook => host.onClose(hook),
});
```

- `makeTool` handles native result formatting, error rendering, taint
  classification and tool ABI. This bridge does **none** of those things.
- Portable execution is **unchanged**: errors, denied results and approval
  interrupts are passed through, never converted into allowed outcomes.
- `bind({capabilityIds})` retains its strict static capability allowlist;
  native host identity/scope authorization is checked at each execution by
  its own `control()`.
- No tool registration is possible without an explicitly supplied
  `register` callback; headless hosts don't need this helper.
- EI's `projectResult` / `projectError` already cover portable projection;
  this bridge deliberately **does not duplicate** their work.

## Honest cost / experimental gate

This bridge removes repeated assembly of a native descriptor and event-tool
execute callback; it does **not** remove host-owned risk/permission policies,
taint classification, receipt authority, continuation or domain-specific
result rendering. The measured candidate Muffin adapter remains **392 lines**;
no change to that consumer or its npm pin is included. #272 must compare full
host LOC across two genuinely different host-native ABIs and report total
new library code. If this adds more complexity than it saves, delete this
helper before declaring a stable Host Adapter Kit.

Compatibility: additive ESM export and TypeScript declaration from
`mcp-event-intelligence/embedded` in the repository's candidate; public
npm 0.11.0 is unchanged. No persisted schema, transport, secrets or policy
migration. No external-host certification from the locally authored tests.
