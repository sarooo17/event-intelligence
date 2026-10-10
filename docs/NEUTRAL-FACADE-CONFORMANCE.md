# Neutral embedded facade — real-host conformance slice

Tracking [#42](https://github.com/sarooo17/event-intelligence/issues/42).

EI already exposes `createEventIntelligence()` for neutral, host-owned embedded integration. Previous tests verified callback composition and synthetic mock hosts. This conformance slice runs the **existing real EI reference host, real event store, Pattern engine and wake coordinator** behind the neutral facade, using an opaque in-memory runtime continuation and durable EI files.

**Scope of this real-host test:** the conformance harness invokes its own lower-level `host.triggerControl` methods for management cases. This proves the same host/engine lifecycle remains functional when the facade installs wake delivery, **not** that every management action passed through the facade's model-facing authorization tools.

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

Two separate, focused facade tests additionally check (1) a host `runtime.control()` denial prevents durable mutation even when an agent requests `trigger_create`, and (2) a host-owned receipt acknowledged to durable state before a simulated crash prevents a second delivery upon restarting the facade. The latter uses a stable in-memory receipt set as a simulated host persistence layer: it validates forwarding of `hasReceipt()` and deterministic receipt identity, but **not** actual database durability or restart across processes.

The testing target is *not* an independent third-party runtime and does *not* prove automatic compatibility with ChatGPT, Codex, Claude Code or Cursor. Additional clean-room implementations must still be tested with the real host's own approval, cancellation, ownership and MCP-session code. Full conformance v3 (multi-host, adversarial policy and measurable installation cost) remains open in #42.
