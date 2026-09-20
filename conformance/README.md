# Conformance

The fixtures in this directory exercise the internal Event Intelligence Protocol, not official MCP conformance.

A conforming adapter in this repository must:

1. produce values accepted by the canonical runtime schemas;
2. preserve `traceId`, `subscriptionId`, and `sourceEventId` across event -> decision -> wake;
3. reject invalid lifecycle transitions;
4. deduplicate a repeated `environmentId + subscriptionId + sourceEventId`;
5. produce a verifiable audit chain;
6. avoid treating semantic match as authorization for downstream actions.

Run:

```bash
npm run check
```

The official MCP Events draft remains upstream and experimental. This conformance suite is intentionally scoped to the project's internal control-plane contracts.
