import {
  SemanticConditionEngine,
} from '../semantic/conditionEngine.js';
import type {
  SemanticDecision,
  SemanticEvaluator,
} from '../semantic/types.js';
import type {
  TriggerSourceEvent,
} from '../intelligenceProtocol/triggerSchemas.js';
import {
  localDateTimeToUtc,
  zonedParts,
} from '../composite/temporal.js';
import type {
  PatternArithmeticValue,
  PatternAstV2Definition,
  PatternNodeV2,
  PatternWindow,
  PatternMeasure,
} from '../intelligenceProtocol/patternV2Schemas.js';

export interface PatternV2SemanticDecision {
  nodeId: string;
  decision: SemanticDecision;
}

export interface PatternV2Candidate {
  bindings: Record<string, TriggerSourceEvent[]>;
  events: TriggerSourceEvent[];
  startIndex: number;
  endIndex: number;
  pendingUntil?: string;
  semanticDecisions: PatternV2SemanticDecision[];
}

export interface PatternV2Evaluation {
  matches: PatternV2Candidate[];
  pending: PatternV2Candidate[];
  semanticEvaluations: number;
  truncated: boolean;
}

interface EvaluationContext {
  events: TriggerSourceEvent[];
  evaluator: SemanticEvaluator | null;
  now: Date;
  maxCandidates: number;
  maxSemanticEvaluations: number;
  semanticEvaluations: number;
  truncated: boolean;
  semanticCache: Map<string, SemanticDecision>;
}

function eventIdentity(event: TriggerSourceEvent): string {
  return [
    event.serverId ?? '-',
    event.sourceEventId,
  ].join(':');
}

function eventOrder(
  left: TriggerSourceEvent,
  right: TriggerSourceEvent,
): number {
  return (
    Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
    left.sourceEventId.localeCompare(right.sourceEventId) ||
    left.clauseId.localeCompare(right.clauseId)
  );
}

function stableEvents(
  bindings: Record<string, TriggerSourceEvent[]>,
): TriggerSourceEvent[] {
  const seen = new Set<string>();
  const output: TriggerSourceEvent[] = [];
  for (const events of Object.values(bindings)) {
    for (const event of events) {
      const key = eventIdentity(event);
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(event);
    }
  }
  return output.sort(eventOrder);
}

function indexFor(
  all: TriggerSourceEvent[],
  event: TriggerSourceEvent,
): number {
  return all.findIndex(
    (candidate) =>
      candidate.clauseId === event.clauseId &&
      eventIdentity(candidate) === eventIdentity(event),
  );
}

function candidateFromBindings(
  bindings: Record<string, TriggerSourceEvent[]>,
  all: TriggerSourceEvent[],
  extra: Partial<PatternV2Candidate> = {},
): PatternV2Candidate {
  const events = stableEvents(bindings);
  const indexes = events
    .map((event) => indexFor(all, event))
    .filter((index) => index >= 0);
  return {
    bindings,
    events,
    startIndex: indexes.length ? Math.min(...indexes) : -1,
    endIndex: indexes.length ? Math.max(...indexes) : -1,
    semanticDecisions: [],
    ...extra,
  };
}

function emptyCandidate(): PatternV2Candidate {
  return {
    bindings: {},
    events: [],
    startIndex: -1,
    endIndex: -1,
    semanticDecisions: [],
  };
}

function cloneBindings(
  bindings: Record<string, TriggerSourceEvent[]>,
): Record<string, TriggerSourceEvent[]> {
  return Object.fromEntries(
    Object.entries(bindings).map(([ref, events]) => [ref, [...events]]),
  );
}

function mergeCandidates(
  left: PatternV2Candidate,
  right: PatternV2Candidate,
  all: TriggerSourceEvent[],
): PatternV2Candidate | null {
  const leftIds = new Set(left.events.map(eventIdentity));
  if (right.events.some((event) => leftIds.has(eventIdentity(event)))) {
    return null;
  }

  const bindings = cloneBindings(left.bindings);
  for (const [ref, events] of Object.entries(right.bindings)) {
    bindings[ref] = [...(bindings[ref] ?? []), ...events].sort(eventOrder);
  }

  const pendingUntil = [left.pendingUntil, right.pendingUntil]
    .filter(Boolean)
    .sort()
    .at(-1);

  return candidateFromBindings(bindings, all, {
    ...(pendingUntil ? { pendingUntil } : {}),
    semanticDecisions: [
      ...left.semanticDecisions,
      ...right.semanticDecisions,
    ],
  });
}

function candidateSignature(candidate: PatternV2Candidate): string {
  return candidate.events
    .map((event) => `${event.clauseId}:${eventIdentity(event)}`)
    .sort()
    .join('|');
}

function dedupe(
  candidates: PatternV2Candidate[],
  max: number,
): {
  values: PatternV2Candidate[];
  truncated: boolean;
} {
  const seen = new Set<string>();
  const values: PatternV2Candidate[] = [];
  let truncated = false;

  for (const candidate of candidates) {
    const key = [
      candidateSignature(candidate),
      candidate.pendingUntil ?? '-',
    ].join('#');
    if (seen.has(key)) continue;
    seen.add(key);
    if (values.length >= max) {
      truncated = true;
      break;
    }
    values.push(candidate);
  }

  return { values, truncated };
}

function getByPath(source: unknown, path: string): unknown {
  let current = source;
  for (const part of path.split('.')) {
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function selectedEvent(
  candidate: PatternV2Candidate,
  ref: string,
  select: 'first' | 'last' | 'nth',
  nth?: number,
): TriggerSourceEvent | null {
  const events = [...(candidate.bindings[ref] ?? [])].sort(eventOrder);
  if (!events.length) return null;
  if (select === 'first') return events[0] ?? null;
  if (select === 'last') return events.at(-1) ?? null;
  return events[nth ?? 0] ?? null;
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : null;
}

function evaluateValue(
  value: PatternArithmeticValue,
  candidate: PatternV2Candidate,
): unknown {
  if (value.kind === 'literal') return value.value;

  if (value.kind === 'field') {
    const event = selectedEvent(
      candidate,
      value.ref,
      value.select,
      value.nth,
    );
    return event ? getByPath(event.data, value.path) : undefined;
  }

  if (value.kind === 'occurredAt') {
    const event = selectedEvent(
      candidate,
      value.ref,
      value.select,
      value.nth,
    );
    return event ? Date.parse(event.occurredAt) : undefined;
  }

  const args = value.args.map(
    (arg: PatternArithmeticValue) => evaluateValue(arg, candidate),
  );
  const numbers = args.map(numeric);
  if (numbers.some((item: number | null) => item === null)) return undefined;
  const resolved = numbers as number[];

  if (value.op === 'abs') return Math.abs(resolved[0]!);
  if (value.op === 'add') return resolved.reduce((sum, item) => sum + item, 0);
  if (value.op === 'subtract') {
    return resolved.slice(1).reduce((result, item) => result - item, resolved[0]!);
  }
  if (value.op === 'multiply') {
    return resolved.reduce((result, item) => result * item, 1);
  }
  if (resolved.slice(1).some((item) => item === 0)) return undefined;
  return resolved.slice(1).reduce((result, item) => result / item, resolved[0]!);
}

function compareNumeric(
  actual: number,
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte',
  expected: number,
): boolean {
  if (op === 'eq') return actual === expected;
  if (op === 'neq') return actual !== expected;
  if (op === 'gt') return actual > expected;
  if (op === 'gte') return actual >= expected;
  if (op === 'lt') return actual < expected;
  return actual <= expected;
}

function compareValue(
  actual: unknown,
  node: Extract<PatternNodeV2, { kind: 'compare' }>,
  candidate: PatternV2Candidate,
): boolean {
  if (node.op === 'isNull') return actual === null || actual === undefined;

  if (node.op === 'type') {
    const expected = node.expectedType;
    if (!expected) return false;
    if (expected === 'null') return actual === null;
    if (expected === 'array') return Array.isArray(actual);
    if (expected === 'object') {
      return (
        actual !== null &&
        typeof actual === 'object' &&
        !Array.isArray(actual)
      );
    }
    return typeof actual === expected;
  }

  if (node.op === 'in' || node.op === 'notIn') {
    const present = (node.values ?? []).some(
      (value: unknown) => value === actual,
    );
    return node.op === 'in' ? present : !present;
  }

  if (node.op === 'between') {
    if (node.lower === undefined || node.upper === undefined) return false;
    if (typeof actual === 'number') {
      return (
        typeof node.lower === 'number' &&
        typeof node.upper === 'number' &&
        actual >= node.lower &&
        actual <= node.upper
      );
    }
    if (typeof actual === 'string') {
      return (
        typeof node.lower === 'string' &&
        typeof node.upper === 'string' &&
        actual >= node.lower &&
        actual <= node.upper
      );
    }
    return false;
  }

  const expected = node.right
    ? evaluateValue(node.right, candidate)
    : node.values?.[0];

  if (node.op === 'eq') return actual === expected;
  if (node.op === 'neq') return actual !== expected;
  if (
    node.op === 'gt' ||
    node.op === 'gte' ||
    node.op === 'lt' ||
    node.op === 'lte'
  ) {
    return (
      typeof actual === 'number' &&
      typeof expected === 'number' &&
      compareNumeric(actual, node.op, expected)
    );
  }

  if (node.op === 'contains') {
    if (typeof actual === 'string') return actual.includes(String(expected));
    if (Array.isArray(actual)) return actual.includes(expected);
    return false;
  }
  if (node.op === 'startsWith') {
    return typeof actual === 'string' &&
      actual.startsWith(String(expected ?? ''));
  }
  if (node.op === 'endsWith') {
    return typeof actual === 'string' &&
      actual.endsWith(String(expected ?? ''));
  }
  if (node.op === 'regex') {
    if (typeof actual !== 'string' || typeof expected !== 'string') return false;
    try {
      return new RegExp(expected, node.flags ?? '').test(actual);
    } catch {
      return false;
    }
  }
  return false;
}

function aggregateValues(
  candidate: PatternV2Candidate,
  ref: string,
  path?: string,
): unknown[] {
  const events = [...(candidate.bindings[ref] ?? [])].sort(eventOrder);
  return events
    .map((event) => path ? getByPath(event.data, path) : event)
    .filter((value) => value !== undefined);
}

export function evaluatePatternAggregate(
  candidate: PatternV2Candidate,
  input: {
    function:
      | 'sum'
      | 'avg'
      | 'min'
      | 'max'
      | 'count'
      | 'countDistinct'
      | 'first'
      | 'last'
      | 'nth'
      | 'stddev'
      | 'percentile';
    ref: string;
    path?: string;
    nth?: number;
    percentile?: number;
  },
): unknown {
  const values = aggregateValues(candidate, input.ref, input.path);
  if (input.function === 'count') {
    return (candidate.bindings[input.ref] ?? []).length;
  }
  if (input.function === 'countDistinct') {
    return new Set(values.map((value) => JSON.stringify(value))).size;
  }
  if (input.function === 'first') return values[0];
  if (input.function === 'last') return values.at(-1);
  if (input.function === 'nth') return values[input.nth ?? 0];

  const numbers = values
    .map(numeric)
    .filter((value): value is number => value !== null);
  if (!numbers.length || numbers.length !== values.length) return undefined;

  if (input.function === 'sum') {
    return numbers.reduce((sum, value) => sum + value, 0);
  }
  if (input.function === 'avg') {
    return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  }
  if (input.function === 'min') return Math.min(...numbers);
  if (input.function === 'max') return Math.max(...numbers);
  if (input.function === 'stddev') {
    const mean = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
    const variance = numbers.reduce(
      (sum, value) => sum + (value - mean) ** 2,
      0,
    ) / numbers.length;
    return Math.sqrt(variance);
  }

  const percentile = input.percentile ?? 0.5;
  const ordered = [...numbers].sort((a, b) => a - b);
  if (ordered.length === 1) return ordered[0];
  const position = (ordered.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower];
  const weight = position - lower;
  return ordered[lower]! * (1 - weight) + ordered[upper]! * weight;
}

function windowMatches(
  candidate: PatternV2Candidate,
  window: PatternWindow,
): boolean {
  if (!candidate.events.length) return true;
  const times = candidate.events.map((event) => Date.parse(event.occurredAt));
  const earliest = Math.min(...times);
  const latest = Math.max(...times);
  const span = latest - earliest;

  if (window.type === 'within' || window.type === 'sliding') {
    return span <= window.sizeMs;
  }

  if (window.type === 'session') {
    const sorted = [...times].sort((a, b) => a - b);
    return sorted.every(
      (time, index) =>
        index === 0 || time - sorted[index - 1]! <= window.gapMs,
    );
  }

  if (window.type === 'count') {
    return (
      candidate.startIndex >= 0 &&
      candidate.endIndex - candidate.startIndex + 1 <= window.size
    );
  }

  const offset = window.offsetMs;
  if (window.type === 'tumbling') {
    const firstBucket = Math.floor((earliest - offset) / window.sizeMs);
    const lastBucket = Math.floor((latest - offset) / window.sizeMs);
    return firstBucket === lastBucket;
  }

  const latestStart =
    Math.floor((latest - offset) / window.hopMs) * window.hopMs + offset;
  const earliestStart = latest - window.sizeMs + 1;
  for (
    let start = latestStart;
    start >= earliestStart;
    start -= window.hopMs
  ) {
    if (earliest >= start && latest < start + window.sizeMs) return true;
  }
  return false;
}

function eventsForRef(
  context: EvaluationContext,
  ref: string,
): TriggerSourceEvent[] {
  return context.events
    .filter((event) => event.clauseId === ref)
    .sort(eventOrder);
}

function latestBoundEvent(
  candidate: PatternV2Candidate,
  ref: string,
): TriggerSourceEvent | null {
  return [...(candidate.bindings[ref] ?? [])].sort(eventOrder).at(-1) ?? null;
}

function withBindingEvents(
  candidate: PatternV2Candidate,
  ref: string,
  events: TriggerSourceEvent[],
  all: TriggerSourceEvent[],
): PatternV2Candidate {
  const bindings = cloneBindings(candidate.bindings);
  const merged = new Map<string, TriggerSourceEvent>();
  for (const event of [...(bindings[ref] ?? []), ...events]) {
    merged.set(eventIdentity(event), event);
  }
  bindings[ref] = [...merged.values()].sort(eventOrder);
  return candidateFromBindings(bindings, all, {
    ...(candidate.pendingUntil
      ? { pendingUntil: candidate.pendingUntil }
      : {}),
    semanticDecisions: [...candidate.semanticDecisions],
  });
}

function calendarNodeMatches(
  node: Extract<PatternNodeV2, { kind: 'calendar' }>,
  event: TriggerSourceEvent,
): boolean {
  const parts = zonedParts(event.occurredAt, node.timezone);
  const minutes = parts.hour * 60 + parts.minute;
  const parseClock = (value: string) => {
    const [hour, minute] = value.split(':').map(Number);
    return hour! * 60 + minute!;
  };

  if (node.weekdays && !node.weekdays.includes(parts.weekday)) return false;
  if (node.dates && !node.dates.includes(parts.date)) return false;
  if (
    node.dateRange &&
    (parts.date < node.dateRange.start || parts.date > node.dateRange.end)
  ) {
    return false;
  }
  if (node.dayOfMonth && !node.dayOfMonth.includes(parts.day)) return false;

  if (node.before && node.after) {
    const before = parseClock(node.before);
    const after = parseClock(node.after);
    if (after <= before) {
      return minutes >= after && minutes <= before;
    }
    return minutes >= after || minutes <= before;
  }
  if (node.before && minutes > parseClock(node.before)) return false;
  if (node.after && minutes < parseClock(node.after)) return false;
  return true;
}

function absenceNodeDueAt(
  node: Extract<PatternNodeV2, { kind: 'absence' }>,
  anchor: TriggerSourceEvent,
): Date {
  if (node.forMs) {
    return new Date(Date.parse(anchor.occurredAt) + node.forMs);
  }
  const parts = zonedParts(anchor.occurredAt, node.timezone!);
  const due = localDateTimeToUtc(
    parts,
    node.untilLocalTime!,
    node.timezone!,
  );
  return due.getTime() < Date.parse(anchor.occurredAt)
    ? new Date(anchor.occurredAt)
    : due;
}

function stateMatches(
  candidate: PatternV2Candidate,
  node: Extract<PatternNodeV2, { kind: 'state' }>,
): boolean {
  const events = [...(candidate.bindings[node.ref] ?? [])].sort(eventOrder);
  if (!events.length) return false;
  const values = events.map((event) => getByPath(event.data, node.path));

  if (node.op === 'stableFor') {
    if (events.length < 2) return false;
    const stable = values.every((value) => value === values[0]);
    const span =
      Date.parse(events.at(-1)!.occurredAt) -
      Date.parse(events[0]!.occurredAt);
    return stable && span >= (node.forMs ?? 0);
  }

  if (events.length < 2) return false;
  const previous = values.at(-2);
  const current = values.at(-1);

  if (node.op === 'changed') return previous !== current;
  if (node.op === 'changedFrom') {
    return previous === node.from && current === node.to;
  }

  const before = numeric(previous);
  const after = numeric(current);
  if (before === null || after === null || node.value === undefined) return false;

  if (node.op === 'crossesAbove') {
    return before <= node.value && after > node.value;
  }
  if (node.op === 'crossesBelow') {
    return before >= node.value && after < node.value;
  }

  let measured: number;
  if (node.op === 'increasedBy') measured = after - before;
  else if (node.op === 'decreasedBy') measured = before - after;
  else if (node.op === 'delta') measured = after - before;
  else {
    if (before === 0) return false;
    measured = ((after - before) / Math.abs(before)) * 100;
  }

  return compareNumeric(
    measured,
    node.comparator,
    node.value,
  );
}

function semanticSource(
  candidate: PatternV2Candidate,
  refs: string[],
): Record<string, unknown> {
  const source: Record<string, unknown> = {};
  for (const ref of refs) {
    const events = [...(candidate.bindings[ref] ?? [])].sort(eventOrder);
    if (events.length === 1) {
      source[ref] = events[0]!.data;
    } else if (events.length > 1) {
      source[ref] = events.at(-1)!.data;
      source[`${ref}Events`] = events.map((event) => event.data);
    }
  }
  return source;
}

async function evaluateNode(
  node: PatternNodeV2,
  context: EvaluationContext,
): Promise<PatternV2Candidate[]> {
  const all = context.events;

  if (node.kind === 'event') {
    return all
      .filter((event) => event.clauseId === node.ref)
      .map((event) =>
        candidateFromBindings({ [node.ref]: [event] }, all)
      );
  }

  if (node.kind === 'anyOf') {
    const candidates = (
      await Promise.all(
        node.children.map((child: PatternNodeV2) =>
          evaluateNode(child, context)
        ),
      )
    ).flat();
    const limited = dedupe(candidates, context.maxCandidates);
    context.truncated ||= limited.truncated;
    return limited.values;
  }

  if (node.kind === 'allOf') {
    let current = [emptyCandidate()];
    for (const child of node.children as PatternNodeV2[]) {
      const next = await evaluateNode(child, context);
      const combined: PatternV2Candidate[] = [];
      for (const left of current) {
        for (const right of next) {
          const merged = mergeCandidates(left, right, all);
          if (merged) combined.push(merged);
        }
      }
      const limited = dedupe(combined, context.maxCandidates);
      context.truncated ||= limited.truncated;
      current = limited.values;
      if (!current.length) break;
    }
    return current;
  }

  if (node.kind === 'sequence') {
    let current = await evaluateNode(node.children[0]!, context);

    for (const child of (node.children as PatternNodeV2[]).slice(1)) {
      const next = await evaluateNode(child, context);
      const combined: PatternV2Candidate[] = [];

      for (const left of current) {
        const compatible = next
          .filter((right) => {
            if (!right.events.length) return true;
            if (!left.events.length) return true;
            if (right.startIndex <= left.endIndex) return false;
            if (
              node.contiguity === 'next' &&
              right.startIndex !== left.endIndex + 1
            ) {
              return false;
            }
            return true;
          })
          .sort((a, b) => a.startIndex - b.startIndex);

        const selected =
          node.contiguity === 'followedBy'
            ? compatible.slice(0, 1)
            : compatible;

        for (const right of selected) {
          const merged = mergeCandidates(left, right, all);
          if (merged) combined.push(merged);
        }
      }

      const limited = dedupe(combined, context.maxCandidates);
      context.truncated ||= limited.truncated;
      current = limited.values;
      if (!current.length) break;
    }
    return current;
  }

  if (node.kind === 'repeat') {
    const units = (await evaluateNode(node.child, context))
      .filter((candidate) => candidate.events.length)
      .sort((a, b) =>
        a.startIndex - b.startIndex ||
        a.endIndex - b.endIndex
      );
    const max = Math.min(
      node.max ?? units.length,
      units.length,
    );
    const output: Array<{ candidate: PatternV2Candidate; count: number }> = [];

    if (node.min === 0) {
      output.push({ candidate: emptyCandidate(), count: 0 });
    }

    const walk = (
      start: number,
      selected: PatternV2Candidate,
      count: number,
    ) => {
      if (count >= node.min) {
        output.push({ candidate: selected, count });
        if (output.length >= context.maxCandidates) {
          context.truncated = true;
          return;
        }
      }
      if (count >= max) return;

      for (let index = start; index < units.length; index += 1) {
        const unit = units[index]!;
        if (
          selected.events.length &&
          unit.startIndex <= selected.endIndex
        ) {
          continue;
        }
        const merged = mergeCandidates(selected, unit, all);
        if (!merged) continue;
        walk(index + 1, merged, count + 1);
        if (context.truncated) return;
      }
    };

    walk(0, emptyCandidate(), 0);

    output.sort((a, b) =>
      node.mode === 'greedy'
        ? b.count - a.count || a.candidate.startIndex - b.candidate.startIndex
        : a.count - b.count || a.candidate.startIndex - b.candidate.startIndex
    );

    return dedupe(
      output.map((entry) => entry.candidate),
      context.maxCandidates,
    ).values;
  }

  if (node.kind === 'optional') {
    const child = await evaluateNode(node.child, context);
    const candidates = node.mode === 'greedy'
      ? [...child, emptyCandidate()]
      : [emptyCandidate(), ...child];
    return dedupe(candidates, context.maxCandidates).values;
  }

  if (node.kind === 'window') {
    return (await evaluateNode(node.child, context))
      .filter((candidate) => windowMatches(candidate, node.window));
  }

  if (node.kind === 'calendar') {
    return (await evaluateNode(node.child, context))
      .filter((candidate) => {
        const event = latestBoundEvent(candidate, node.ref);
        return event ? calendarNodeMatches(node, event) : false;
      });
  }

  if (node.kind === 'notPresent') {
    const forbidden = eventsForRef(context, node.ref);
    return (await evaluateNode(node.child, context))
      .filter(() => forbidden.length === 0);
  }

  if (node.kind === 'after') {
    return (await evaluateNode(node.child, context))
      .filter((candidate) => {
        const event = latestBoundEvent(candidate, node.ref);
        const anchor = latestBoundEvent(candidate, node.afterRef);
        return Boolean(
          event &&
          anchor &&
          Date.parse(event.occurredAt) > Date.parse(anchor.occurredAt),
        );
      });
  }

  if (node.kind === 'until') {
    return (await evaluateNode(node.child, context))
      .filter((candidate) => {
        const event = latestBoundEvent(candidate, node.ref);
        const boundary = latestBoundEvent(candidate, node.beforeRef);
        return Boolean(
          event &&
          boundary &&
          Date.parse(event.occurredAt) <= Date.parse(boundary.occurredAt),
        );
      });
  }

  if (node.kind === 'threshold') {
    const refEvents = eventsForRef(context, node.ref);
    if (refEvents.length < node.atLeast) return [];
    return (await evaluateNode(node.child, context))
      .map((candidate) =>
        withBindingEvents(
          candidate,
          node.ref,
          refEvents.slice(0, node.atLeast),
          context.events,
        )
      );
  }

  if (node.kind === 'distinct') {
    const chosen: TriggerSourceEvent[] = [];
    const values = new Set<string>();
    for (const event of eventsForRef(context, node.ref)) {
      const value = getByPath(event.data, node.path);
      if (
        typeof value !== 'string' &&
        typeof value !== 'number' &&
        typeof value !== 'boolean'
      ) {
        continue;
      }
      const key = JSON.stringify(value);
      if (values.has(key)) continue;
      values.add(key);
      chosen.push(event);
      if (values.size >= node.atLeast) break;
    }
    if (values.size < node.atLeast) return [];
    return (await evaluateNode(node.child, context))
      .map((candidate) =>
        withBindingEvents(candidate, node.ref, chosen, context.events)
      );
  }

  if (node.kind === 'rate') {
    const refEvents = eventsForRef(context, node.ref);
    if (!refEvents.length) return [];
    const latest = Math.max(
      context.now.getTime(),
      ...refEvents.map((event) => Date.parse(event.occurredAt)),
    );
    const inWindow = refEvents.filter(
      (event) => latest - Date.parse(event.occurredAt) <= node.perMs,
    );
    if (inWindow.length < node.atLeast) return [];
    return (await evaluateNode(node.child, context))
      .map((candidate) =>
        withBindingEvents(
          candidate,
          node.ref,
          inWindow.slice(-node.atLeast),
          context.events,
        )
      );
  }

  if (node.kind === 'debounce') {
    const refEvents = eventsForRef(context, node.ref);
    const latest = refEvents.at(-1);
    if (!latest) return [];
    const dueAt = Date.parse(latest.occurredAt) + node.forMs;
    return (await evaluateNode(node.child, context))
      .map((candidate) => {
        const augmented = withBindingEvents(
          candidate,
          node.ref,
          [latest],
          context.events,
        );
        return {
          ...augmented,
          ...(context.now.getTime() < dueAt
            ? { pendingUntil: new Date(dueAt).toISOString() }
            : {}),
        };
      });
  }

  if (node.kind === 'absence') {
    const bases = await evaluateNode(node.child, context);
    const forbidden = eventsForRef(context, node.ref);
    const output: PatternV2Candidate[] = [];

    for (const base of bases) {
      const anchor = latestBoundEvent(base, node.afterRef);
      if (!anchor) continue;
      const due = absenceNodeDueAt(node, anchor);
      const anchorMs = Date.parse(anchor.occurredAt);
      const blocked = forbidden.some((event) => {
        const at = Date.parse(event.occurredAt);
        return at >= anchorMs && at <= due.getTime();
      });
      if (blocked) continue;
      output.push({
        ...base,
        ...(context.now.getTime() < due.getTime()
          ? { pendingUntil: due.toISOString() }
          : {}),
      });
    }

    return output;
  }

  if (node.kind === 'notNext') {
    const bases = await evaluateNode(node.child, context);
    const forbidden = await evaluateNode(node.forbidden, context);
    return bases.filter((base) => {
      if (!base.events.length) return false;
      return !forbidden.some(
        (candidate) =>
          candidate.events.length &&
          candidate.startIndex === base.endIndex + 1,
      );
    });
  }

  if (node.kind === 'notFollowedBy') {
    const bases = await evaluateNode(node.child, context);
    const forbidden = await evaluateNode(node.forbidden, context);
    const output: PatternV2Candidate[] = [];

    for (const base of bases) {
      if (!base.events.length) continue;
      const anchor = Date.parse(base.events.at(-1)!.occurredAt);
      const dueAt = anchor + node.withinMs;
      const blocked = forbidden.some((candidate) => {
        if (!candidate.events.length) return false;
        const at = Date.parse(candidate.events[0]!.occurredAt);
        return at > anchor && at <= dueAt;
      });
      if (blocked) continue;
      output.push({
        ...base,
        ...(context.now.getTime() < dueAt
          ? { pendingUntil: new Date(dueAt).toISOString() }
          : {}),
      });
    }
    return output;
  }

  const child = await evaluateNode(node.child, context);

  if (node.kind === 'compare') {
    return child.filter((candidate) =>
      compareValue(
        evaluateValue(node.left, candidate),
        node,
        candidate,
      )
    );
  }

  if (node.kind === 'aggregate') {
    return child.filter((candidate) => {
      const actual = evaluatePatternAggregate(candidate, {
        function: node.function,
        ref: node.ref,
        path: node.path,
        nth: node.nth,
        percentile: node.percentile,
      });
      return (
        typeof actual === 'number' &&
        compareNumeric(actual, node.op, node.value)
      );
    });
  }

  if (node.kind === 'state') {
    return child.filter((candidate) => stateMatches(candidate, node));
  }

  const output: PatternV2Candidate[] = [];
  for (const candidate of child) {
    if (!context.evaluator) continue;
    if (
      context.semanticEvaluations >= context.maxSemanticEvaluations
    ) {
      context.truncated = true;
      break;
    }

    const cacheKey = [
      node.id,
      candidateSignature(candidate),
      node.instruction,
    ].join(':');
    let decision = context.semanticCache.get(cacheKey);
    if (!decision) {
      context.semanticEvaluations += 1;
      decision = await new SemanticConditionEngine(
        context.evaluator,
      ).evaluate(
        semanticSource(candidate, node.refs),
        {
          type: 'semantic_boolean',
          instruction: node.instruction,
          input: node.input,
          matchThreshold: node.matchThreshold,
          rejectThreshold: node.rejectThreshold,
          uncertain: node.uncertain,
        },
      );
      if (node.execution.cache) {
        context.semanticCache.set(cacheKey, decision);
      }
    }

    if (!decision.matched) continue;
    output.push({
      ...candidate,
      semanticDecisions: [
        ...candidate.semanticDecisions,
        { nodeId: node.id, decision },
      ],
    });
  }

  return output;
}

export function evaluatePatternMeasure(
  candidate: PatternV2Candidate,
  measure: PatternMeasure,
): unknown {
  const expression = measure.expression;
  if (expression.kind === 'aggregate') {
    return evaluatePatternAggregate(candidate, {
      function: expression.function,
      ref: expression.ref,
      path: expression.path,
      nth: expression.nth,
      percentile: expression.percentile,
    });
  }
  return evaluateValue(expression, candidate);
}

export async function evaluatePatternV2({
  definition,
  events,
  evaluator = null,
  now = new Date(),
}: {
  definition: PatternAstV2Definition;
  events: TriggerSourceEvent[];
  evaluator?: SemanticEvaluator | null;
  now?: Date;
}): Promise<PatternV2Evaluation> {
  const ordered = [...events].sort(eventOrder);
  const context: EvaluationContext = {
    events: ordered,
    evaluator,
    now,
    maxCandidates: definition.execution.maxCandidates,
    maxSemanticEvaluations: definition.execution.maxSemanticEvaluations,
    semanticEvaluations: 0,
    truncated: false,
    semanticCache: new Map(),
  };

  const candidates = await evaluateNode(definition.root, context);
  const limited = dedupe(candidates, context.maxCandidates);
  context.truncated ||= limited.truncated;

  const matches = limited.values.filter(
    (candidate) =>
      !candidate.pendingUntil ||
      Date.parse(candidate.pendingUntil) <= now.getTime(),
  );
  const pending = limited.values.filter(
    (candidate) =>
      candidate.pendingUntil &&
      Date.parse(candidate.pendingUntil) > now.getTime(),
  );

  return {
    matches,
    pending,
    semanticEvaluations: context.semanticEvaluations,
    truncated: context.truncated,
  };
}

export function patternV2CandidateSignature(
  candidate: PatternV2Candidate,
): string {
  return candidateSignature(candidate);
}
