// Compiled in a fresh installed consumer project by clean-room CI.
import { z } from 'zod';
import { toTriggerPlan, type TypedSourcePredicate } from 'mcp-event-intelligence/embedded';

const schema = z.object({ severity: z.number(), title: z.string() });
const predicates: TypedSourcePredicate<z.infer<typeof schema>>[] = [
  { path: 'severity', op: 'gte', value: 4 },
  { path: 'title', op: 'startsWith', value: 'urgent' },
];
const planned = toTriggerPlan<z.infer<typeof schema>>({
  when: { event: 'issue.changed', where: predicates },
  then: {
    target: { runtime: 'headless', kind: 'task', id: 'case' },
    instruction: 'Review safely.',
  },
});
void planned;

// @ts-expect-error dangerous typo: nonexistent provider payload path
toTriggerPlan<z.infer<typeof schema>>({ when: { event: 'issue.changed', where: [{ path: 'unknown', op: 'eq', value: 3 }] }, then: { target: { runtime: 'x', kind: 'task', id: 'one' }, instruction: 'Check.' } });
// @ts-expect-error wrong field operator and value type
toTriggerPlan<z.infer<typeof schema>>({ when: { event: 'issue.changed', where: [{ path: 'title', op: 'gte', value: 5 }] }, then: { target: { runtime: 'x', kind: 'task', id: 'one' }, instruction: 'Check.' } });
