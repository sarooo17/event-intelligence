// Compile-only public API contract. Every @ts-expect-error is a rejection
// guarantee: tsc fails if a forbidden payload path/type becomes accepted.
import { z } from 'zod';
import {
  toTriggerPlan,
  type TypedSourcePredicate,
  type TypedSimpleTriggerPlanInput,
} from '../../scripts/embedded-host-kit.mjs';

const payloadSchema = z.object({
  severity: z.number(),
  title: z.string(),
  active: z.boolean(),
  metadata: z.object({ owner: z.string() }).optional(),
});
type IssueEvent = z.infer<typeof payloadSchema>;
const then = {
  target: { runtime: 'test-host', kind: 'workflow', id: 'one' },
  instruction: 'Investigate a synthetic event.',
};
const typed = toTriggerPlan<IssueEvent>({
  when: {
    event: 'test.issue.changed',
    where: [
      { path: 'severity', op: 'gte', value: 3 },
      { path: 'severity', op: 'in', value: [1, 2, 3] },
      { path: 'title', op: 'regex', value: 'critical', flags: 'i' },
      { path: 'title', op: 'startsWith', value: 'urgent' },
      { path: 'active', op: 'eq', value: true },
      { path: 'metadata', op: 'exists', value: true },
      { path: 'severity', op: 'type', value: 'number' },
    ],
  },
  then,
});
const canonicalPlan: import('../../dist/src/intelligenceProtocol/index.js').TriggerPlanInput = typed;
void canonicalPlan;

const onePredicate: TypedSourcePredicate<IssueEvent> = {
  path: 'severity', op: 'between', value: [1, 5],
};
void onePredicate;
const checkedShape: TypedSimpleTriggerPlanInput<IssueEvent> = {
  when: { event: 'test.issue.changed', where: [{ path: 'active', op: 'neq', value: false }] },
  then,
};
void checkedShape;

// @ts-expect-error unknown provider field must be refused before planning
toTriggerPlan<IssueEvent>({ when: { event: 'x', where: [{ path: 'secret', op: 'eq', value: 'no' }] }, then });
// @ts-expect-error string field cannot use numeric greater-than
toTriggerPlan<IssueEvent>({ when: { event: 'x', where: [{ path: 'title', op: 'gt', value: 3 }] }, then });
// @ts-expect-error numeric comparison requires number value
toTriggerPlan<IssueEvent>({ when: { event: 'x', where: [{ path: 'severity', op: 'gte', value: 'high' }] }, then });
// @ts-expect-error string prefix must not work on numeric field
toTriggerPlan<IssueEvent>({ when: { event: 'x', where: [{ path: 'severity', op: 'startsWith', value: '1' }] }, then });
// @ts-expect-error boolean field cannot accept string equality
toTriggerPlan<IssueEvent>({ when: { event: 'x', where: [{ path: 'active', op: 'eq', value: 'true' }] }, then });
// @ts-expect-error nested provider dot-path requires the canonical planner, not unsafe type assertion
toTriggerPlan<IssueEvent>({ when: { event: 'x', where: [{ path: 'metadata.owner', op: 'eq', value: 'test' }] }, then });
// @ts-expect-error unknown extra modifier remains forbidden
toTriggerPlan<IssueEvent>({ when: { event: 'x', where: [{ path: 'severity', op: 'gte', value: 1, negate: true }] }, then });

// Existing untyped calls are API-compatible (but planner validates at runtime).
const untyped = toTriggerPlan({
  when: { event: 'test.issue.changed', where: [{ path: 'nested.dynamic', op: 'exists', value: true }] },
  then,
});
void untyped;
