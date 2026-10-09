# Simple trigger authoring

For common one-event conditions, `toTriggerPlan()` creates a **canonical** planner input from a compact `when / then` declaration. It does **not** register a trigger, call providers, grant authorization, or execute a second expression language.

```js
import { toTriggerPlan } from 'mcp-event-intelligence/embedded';

const input = toTriggerPlan({
  when: {
    event: 'github.issue.updated',
    serverId: 'github',
    where: [{ path: 'priority', op: 'gte', value: 2 }],
  },
  then: {
    target: host.currentContinuationTarget(),
    instruction: 'Review this issue for meaningful changes.',
  },
  lifecycle: { oneShot: false, maxFirings: 10 },
});

// The canonical planner validates against live, host-owned MCP source metadata.
const scoped = await host.scope(scopeId);
const plan = await scoped.planTrigger(input);

// An authenticated and approved host actor still creates the durable trigger.
await scoped.triggerControl.createTrigger({
  definition: plan.definition,
  connectionIds: plan.connectionIds,
  actor: host.currentActor(),
  owner: host.currentOwner(),
  // Use the host's existing policy/approval receipt where required.
});
```

**Never create durable triggers directly on behalf of an agent without running the host's authorization/control gate.** The helper only validates the declaration shape through `parseTriggerPlanInput`. The existing `TriggerPlanner` resolves active source descriptors, checks arguments and field paths, and builds Pattern AST v2.

### Semantics and limitations

- One source/event clause, one opaque host continuation target.
- Optional `id`, `serverId`, subscription `arguments`, `where` predicate array, `withinMs`, `eventTime`, `description` and standard trigger `lifecycle`.
- Defaults and event/continuation validation come from the canonical `TriggerPlanInput` schema.
- Unknown keys fail explicitly rather than being silently dropped. An ambiguous event source fails during real planning unless you choose `serverId`.
- Complex correlation/sequence/semantic patterns must use the existing advanced planner and canonical Pattern AST v2; no parallel execution or duplicated parser is introduced.
- Typed against exported `SimpleTriggerPlanInput` and `TriggerPlanInput`.

Run the focused test:

```bash
npm run build
node --test test/simple-trigger-authoring.test.mjs
```

This is one **partial** improvement toward developer experience issue [#46](https://github.com/sarooo17/event-intelligence/issues/46); virtual-time simulation and other planned features are not implemented by this slice.
