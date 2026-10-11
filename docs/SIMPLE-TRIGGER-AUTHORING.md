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

### Optional provider-payload TypeScript inference

The existing `toTriggerPlan()` accepts an **optional explicit payload type**.
For a provider SDK exporting a Zod schema, use `z.infer<typeof schema>`.
Typing is strictly compile-time; no alternate runtime DSL or evaluator exists.

```ts
import { z } from 'zod';
import { toTriggerPlan } from 'mcp-event-intelligence/embedded';
const schema = z.object({ severity: z.number(), title: z.string() });

const plan = toTriggerPlan<z.infer<typeof schema>>({
  when: {
    event: 'test.issue.changed',
    where: [
      { path: 'severity', op: 'gte', value: 3 },
      { path: 'title', op: 'startsWith', value: 'critical' },
    ],
  },
  then: {
    target: { runtime: 'host', kind: 'task', id: 'case' },
    instruction: 'Review this issue.',
  },
});
```

The generic checks top-level field names, scalar value types and applicable
operators at compile time. Discriminated-union source payload types are
supported: fields belonging to any declared variant remain eligible, but
static typing does **not** prove that a field exists on every emitted variant.
Union-valued fields (such as `string | number[]`) are handled distributively
for `contains`, retaining substring and scalar-array membership types.
String-field substring matching accepts scalar operands (string, number,
boolean), which the canonical matcher converts with `String(value)`; array
membership still requires an exactly typed scalar element. It supports `contains` for strings and scalar
array members, and `between` only for comparable strings or numbers; For example, an unknown field, a string supplied
to numeric `gte`, or `gt` on a string field is rejected by TypeScript.
Use an independently verified provider SDK TypeScript payload type when
a Zod schema is unavailable. Types cannot be inferred automatically from
an arbitrary runtime JSON Schema response. **Deep dot-paths and source-schema
validation remain the canonical planner's responsibility; live payload data
must be validated at the trusted MCP ingestion boundary**, not in the planner.
The normal
unannotated `toTriggerPlan()` call remains unchanged.

The exported types are `TypedSourcePredicate<Payload>` and
`TypedSimpleTriggerPlanInput<Payload>`. They do not authorize creation:
the existing canonical Zod parser, scoped source validation, and host-owned
`control()` callback are authoritative. Nothing here calls an LLM.

Compile-positive and compile-negative contract tests are run by:

```sh
npm run build
node --test test/typed-simple-trigger-contract.test.mjs
```
### Headless and TypeScript clean-room verification

The packed release workflow also installs EI into an **independent empty Node
project** and runs `docs/examples/packed-headless-host.mjs`: a headless
host with no agent-facing tools, no model SDK, no provider and no wake
delivery is opened, closed and reopened on the same temporary durable store.
This checks the lifecycle contract, not live service recovery.

In the same external consumer, `docs/examples/packed-typed-simple-trigger.mts`
is checked using TypeScript 6 with both positive `z.infer` payload predicates
and `@ts-expect-error` negative cases. Thus the optional source-typed API
is verified against **the actual npm tarball's public .d.mts exports**,
not just source checkout path imports.
### Runnable clean-room package example

The repo includes [`docs/examples/packed-simple-trigger.mjs`](examples/packed-simple-trigger.mjs).
It is executed in CI from an **empty external Node project** after installing
the candidate `npm pack` tarball, not through the source tree or workspace
aliases. The example creates an isolated host-owned test fixture descriptor,
calls `toTriggerPlan()`, then invokes the **actual** deterministic planner and
checks the canonical Pattern v2 output plus source-schema resolution.

The example is intentionally read-only for trigger state: it creates **zero
durable triggers**, executes **no** provider calls or model invocations, and
does **not** demonstrate live host approval or wake delivery. It must not be
mistaken for full three-host integration conformance (#42).

This is one further partial improvement toward developer experience
issue [#46](https://github.com/sarooo17/event-intelligence/issues/46).
Deterministic virtual time has been implemented separately (#86/#89);
bounded typed-source and restart-simulation tests now have independent
fixtures. Clean-room third-party host conformance and PostgreSQL crash
recovery remain separate acceptance work under #42 and #47.
