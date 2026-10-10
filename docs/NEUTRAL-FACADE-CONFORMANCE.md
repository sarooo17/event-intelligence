# Neutral embedded facade — real-host conformance slice

Tracking [#42](https://github.com/sarooo17/event-intelligence/issues/42).

EI already exposes `createEventIntelligence()` for neutral, host-owned embedded integration. Previous tests verified callback composition and synthetic mock hosts. This conformance slice runs the **existing real EI reference host, real event store, Pattern engine and wake coordinator** behind the neutral facade, using an opaque in-memory runtime continuation and durable EI files.

The existing management-profile conformance exercises:
- threshold matching and no wake below threshold;
- replay/deduplication;
- durable trigger restart and continuation callback identity;
- max-firings lifecycle;
- management: create/list/pause/resume/update/delete;
- structured observability events and redaction.

Run:

```bash
npm run build
node --test test/neutral-facade-conformance.test.mjs
```

The `referenceHostAdapter` can be constructed with `useNeutralFacade: true`. This flag belongs **only to the conformance test harness**; it does not add a per-vendor compatibility branch to EI. The host owns its receipt set and continuation delivery, and EI uses the same standard Pattern store as the existing reference host.

The testing target is *not* an independent third-party runtime and does *not* prove automatic compatibility with ChatGPT, Codex, Claude Code or Cursor. Additional clean-room implementations must still be tested with the real host's own approval, cancellation, ownership and MCP-session code. Full conformance v3 (multi-host, adversarial policy and measurable installation cost) remains open in #42.
