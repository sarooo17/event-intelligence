# Conformance

The fixtures in this directory exercise Event Intelligence's internal runtime contracts, not official MCP conformance.

A conforming adapter in this repository must:

1. produce values accepted by the canonical runtime schemas;
2. normalize provider deliveries into stable event occurrences;
3. preserve source evidence through Pattern matches, derived events and wakes;
4. reject invalid lifecycle transitions;
5. deduplicate replayed occurrences using stable provider/subscription identity;
6. produce a verifiable hash-linked audit chain;
7. treat semantic matches and external event payloads as evidence, never as downstream authorization.

Run:

```bash
npm run check
```

The MCP Events draft remains upstream and experimental. This suite is intentionally scoped to Event Intelligence's own contracts.
