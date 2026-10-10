# Embedded capability allowlisting

Tracking [#43](https://github.com/sarooo17/event-intelligence/issues/43).

Embedded integrations expose host-neutral descriptors with `capability.id`, effect/durability and host-control metadata. A host can now choose **exactly which capabilities are installed in its model tool registry**, before adapter code or registration callbacks are called.

```js
const registered = integration.bind({
  capabilityIds: [
    'event-intelligence.event-sources.list',
    'event-intelligence.trigger.list',
    'event-intelligence.trigger.inspect',
  ],
  adapt: (portableTool) => convertToHostTool(portableTool),
  register: (hostTool) => hostToolRegistry.add(hostTool),
});
```

The explicit allowlist can be empty. Unknown or malformed capability IDs fail before partial registration. Omitting it preserves the existing behavior, **register all**; this is a host-selected exposure policy, not an implicit authority grant. Every action must still go through host-owned principal/owner/tenant policy checks at execution time, and durable mutations require the `control()` callback.

The filter runs **before** calling `adapt()` and `register()`. It therefore does not merely hide a descriptor after a forbidden mutating tool has already been installed.

This covers only embedded registration. The standalone MCP stdio server controls its own exported tools and `MCP_WRITE_ENABLED` flag. A shared complete operation/schema registry spanning both surfaces remains #43 work.

Run:

```bash
npm run build
node --test test/embedded-host-kit.test.mjs
```
