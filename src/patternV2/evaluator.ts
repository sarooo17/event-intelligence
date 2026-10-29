import { readOwnEventPath } from '../protocol/ownPath.js';
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

export interface PatternV2SemanticTrace {
  nodeId: string;
  candidateSignature: string;
  decision: SemanticDecision;
}

export interface PatternV2SemanticCache {
  get(key: string): Promise<SemanticDecision | null> | SemanticDecision | null;
  set(
    key: string,
    decision: SemanticDecision,
  ): Promise<void> | void;
}

export interface PatternV2Evaluation {
  matches: PatternV2Candidate[];
  pending: PatternV2Candidate[];
  // Source-gap deferred deadlines, never independently valid matches.
  incompletePending?: PatternV2Candidate[];
  semanticEvaluations: number;
  semanticCacheHits: number;
  semanticCacheMisses: number;
  semanticTrace: PatternV2SemanticTrace[];
  truncated: boolean;
}

interface EvaluationContext {
  events: TriggerSourceEvent[];
  eventsByRef: Map<string, TriggerSourceEvent[]>;
  incompleteSourceRefs: ReadonlySet<string>;
  incompletePending: PatternV2Candidate[];
  evaluator: SemanticEvaluator | null;
  now: Date;
  maxCandidates: number;
  maxSemanticEvaluations: number;
  semanticEvaluations: number;
  semanticCacheHits: number;
  semanticCacheMisses: number;
  truncated: boolean;
  workSteps: number;
  maxWorkSteps: number;
  workExhausted: boolean;
  semanticCache: Map<string, SemanticDecision>;
  durableSemanticCache: PatternV2SemanticCache | null;
  semanticCacheNamespace: string;
  semanticContextRevision: string;
  semanticCacheTtlMs: number | null;
  semanticTrace: PatternV2SemanticTrace[];
  allowedLatenessMs: number;
}

// Fixed process-local caps are separate from public AST execution fields.
// Every exceeded limit is inconclusive, never a complete no-match.
const MAX_EVALUATION_INPUT_EVENTS = 50_000;
const MAX_EVALUATION_AST_NODES = 4_096;
const MAX_EVALUATION_AST_DEPTH = 128;
const MAX_EVALUATION_WORK_STEPS = 250_000;

function consumeWork(
  context: EvaluationContext,
  units = 1,
): boolean {
  if (context.workExhausted) return false;
  context.workSteps += units;
  if (context.workSteps <= context.maxWorkSteps) return true;
  context.workExhausted = true;
  context.truncated = true;
  return false;
}

function boundedAst(root: PatternNodeV2): boolean {
  // DFS with explicit exits counts each occurrence but only rejects
  // references present on the *active ancestor path*. Reused immutable
  // acyclic subtrees are allowed; circular objects cannot recurse.
  type Frame = { value: unknown; depth: number; exit: boolean };
  const pending: Frame[] = [{ value: root, depth: 0, exit: false }];
  const active = new Set<object>();
  let visited = 0;
  while (pending.length) {
    const { value, depth, exit } = pending.pop()!;
    if (!value || typeof value !== 'object') return false;
    if (exit) {
      active.delete(value);
      continue;
    }
    if (depth > MAX_EVALUATION_AST_DEPTH ||
      ++visited > MAX_EVALUATION_AST_NODES ||
      active.has(value)) return false;
    active.add(value);
    const node = value as Record<string, unknown>;
    pending.push({ value, depth, exit: true });
    const branches: unknown[] = [];
    if (Array.isArray(node.children)) {
      if (node.children.length + visited > MAX_EVALUATION_AST_NODES) {
        return false;
      }
      branches.push(...node.children);
    }
    if (node.child) branches.push(node.child);
    if (node.forbidden && typeof node.forbidden === 'object') {
      branches.push(node.forbidden);
    }
    // A shallow compare may contain arbitrarily deep arithmetic trees.
    // Count these as part of the same bounded structural traversal.
    if (node.kind === 'compare') {
      if (node.left) branches.push(node.left);
      if (node.right) branches.push(node.right);
    }
    if (node.kind === 'arithmetic' && Array.isArray(node.args)) {
      if (node.args.length + visited > MAX_EVALUATION_AST_NODES) {
        return false;
      }
      branches.push(...node.args);
    }
    if (branches.length + visited > MAX_EVALUATION_AST_NODES) return false;
    for (let i=branches.length-1;i>=0;i--){
      pending.push({ value:branches[i], depth:depth+1, exit:false });
    }
  }
  return true;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          stableValue((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return value;
}

function durableSemanticCacheKey(
  context: EvaluationContext,
  node: Extract<PatternNodeV2, { kind: 'semantic' }>,
  candidate: PatternV2Candidate,
): string | null {
  const evaluatorIdentity = String(
    context.evaluator?.cacheIdentity ?? '',
  ).trim();
  if (!evaluatorIdentity || !context.semanticCacheNamespace) {
    return null;
  }

  const payload = stableValue({
    schema: context.semanticCacheTtlMs === null &&
      context.semanticContextRevision === ''
      ? 'pattern-v2-semantic-cache.v1'
      : 'pattern-v2-semantic-cache.v2',
    namespace: context.semanticCacheNamespace,
    ...(context.semanticContextRevision !== ''
      ? { contextRevision: context.semanticContextRevision } : {}),
    ...(context.semanticCacheTtlMs !== null
      ? { expiryWindow: Math.floor(context.now.getTime() /
          context.semanticCacheTtlMs),
          ttlMs: context.semanticCacheTtlMs } : {}),
    evaluator: evaluatorIdentity,
    node: {
      id: node.id,
      refs: node.refs,
      instruction: node.instruction,
      input: node.input,
      matchThreshold: node.matchThreshold,
      rejectThreshold: node.rejectThreshold,
      uncertain: node.uncertain,
    },
    candidate: candidate.events.map((event) => ({
      clauseId: event.clauseId,
      serverId: event.serverId ?? null,
      sourceEventId: event.sourceEventId,
      subscriptionArguments: event.subscriptionArguments ?? {},
    })),
  });

  return JSON.stringify(payload);
}

function eventIdentity(event: TriggerSourceEvent): string {
  // JSON tuple serialization is unambiguous even when server/source IDs
  // contain ':' or '|' (unlike delimiter-joined components).
  return JSON.stringify([
    event.serverId ?? null,
    event.sourceEventId,
    stableValue(event.subscriptionArguments ?? {}),
  ]);
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

// Every candidate merge used to scan the entire source array for every
// bound event (O(events * candidates * bindings)). Cache the first ordered
// location per physical identity; the evaluator never mutates "all".
const orderedIndexes = new WeakMap<
  TriggerSourceEvent[],
  { indexes: Map<string, number>; scanned: number }
>();
function indexedKey(event: TriggerSourceEvent): string {
  return JSON.stringify([event.clauseId, eventIdentity(event)]);
}
function indexFor(
  all: TriggerSourceEvent[],
  event: TriggerSourceEvent,
): number {
  let state = orderedIndexes.get(all);
  if (!state) {
    state = { indexes: new Map(), scanned: 0 };
    orderedIndexes.set(all, state);
  }
  const key = indexedKey(event);
  const known = state.indexes.get(key);
  if (known !== undefined) return known;
  // Lazily index only the input prefix necessary to resolve a witness.
  // Eagerly hashing every buffered event would make a low candidate cap
  // perform the same expensive identity work as a full evaluation.
  while (state.scanned < all.length) {
    const i = state.scanned++;
    const sourceKey = indexedKey(all[i]!);
    if (!state.indexes.has(sourceKey)) state.indexes.set(sourceKey, i);
    if (sourceKey === key) return state.indexes.get(key)!;
  }
  return -1;
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
  // Stable, self-delimiting encoding for persisted pattern signatures.
  return JSON.stringify(candidate.events
    .map((event) => [event.clauseId, eventIdentity(event)])
    .sort((left, right) => {
      const a = JSON.stringify(left);
      const b = JSON.stringify(right);
      // Unicode code-unit ordering is stable across host locales/ICU.
      return a < b ? -1 : a > b ? 1 : 0;
    }));
}

function candidateDedupeKey(candidate: PatternV2Candidate): string {
  return JSON.stringify([
    candidateSignature(candidate),
    candidate.pendingUntil ?? null,
  ]);
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
    const key = candidateDedupeKey(candidate);
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

// A compare expression is re-evaluated for each child candidate. Count
// every structural occurrence, including shared DAG edges, once per node
// invocation; then reserve that work for *each* candidate before executing
// recursive arithmetic. This prevents a wide shallow expression multiplied
// by thousands of candidates from silently bypassing the shared work cap.
function arithmeticNodeCost(value: PatternArithmeticValue): number {
  let cost = 0;
  const pending: PatternArithmeticValue[] = [value];
  while (pending.length) {
    const item = pending.pop()!;
    cost += 1;
    if (item.kind === 'arithmetic') {
      pending.push(...item.args);
    }
  }
  return cost;
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
    return event ? readOwnEventPath(event.data, value.path) : undefined;
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

  // Undefined means the selector/path could not be resolved. General
  // comparisons must fail closed; isNull is the explicit absence operator.
  if (actual === undefined) return false;

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

  if (expected === undefined) return false;

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
    .map((event) => path ? readOwnEventPath(event.data, path) : event)
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

  // A hopping window contains the candidate iff there is a grid-aligned
  // start in [latest - sizeMs + 1, earliest]. The rightmost start <=
  // earliest is sufficient: scanning backwards from latest can take
  // billions of iterations for valid sizeMs >> hopMs input.
  // BigInt avoids an unsafe intermediate (earliest - offset)/hop for
  // large but valid offsets, and gives mathematically exact floor division
  // for negative epochs (JS number/BigInt division normally truncates).
  const first = BigInt(earliest);
  const last = BigInt(latest);
  const hop = BigInt(window.hopMs);
  const gridOffset = BigInt(offset);
  const delta = first - gridOffset;
  const quotient = delta >= 0n
    ? delta / hop
    : -((-delta + hop - 1n) / hop);
  const start = quotient * hop + gridOffset;
  const size = BigInt(window.sizeMs);
  return start >= last - size + 1n && last < start + size;
}

function eventsForRef(
  context: EvaluationContext,
  ref: string,
): TriggerSourceEvent[] {
  // The input is already sorted; index once by ref rather than rescanning
  // up to 50k events for every branch of a wide anyOf or nested predicate.
  const values = context.eventsByRef.get(ref) ?? [];
  // A consumer can still traverse the full returned reference array;
  // charge its size to the shared budget even on cache hits.
  if (!consumeWork(context, values.length)) return [];
  return values;
}

// Threshold and rate count *physical* source events, not repeated deliveries.
// Use the same identity as withBindingEvents so counted occurrences and the
// provenance returned to callers cannot disagree under replay.
function distinctEventsForRef(
  context: EvaluationContext,
  ref: string,
): TriggerSourceEvent[] {
  const seen = new Set<string>();
  return eventsForRef(context, ref).filter((event) => {
    const identity = eventIdentity(event);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
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

// A witness set is copied, hashed and sorted into *each* selected child.
// Charging eventsForRef() once is insufficient: N candidates × M attached
// witnesses may amplify bounded input into unbounded CPU/memory use.
function attachBindingsBounded(
  context: EvaluationContext,
  children: PatternV2Candidate[],
  ref: string,
  witnesses: TriggerSourceEvent[],
): PatternV2Candidate[] {
  const output: PatternV2Candidate[] = [];
  for (const candidate of children) {
    const boundCount = Object.values(candidate.bindings)
      .reduce((total, events) => total + events.length, 0);
    if (!consumeWork(context, Math.max(1, witnesses.length + boundCount))) {
      break;
    }
    output.push(withBindingEvents(candidate, ref, witnesses, context.events));
  }
  return output;
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
  const values = events.map((event) => readOwnEventPath(event.data, node.path));

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

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// A missing source on any forbidden predicate branch prevents a negative
// proof. Inspect only bounded/schema-validated Pattern AST descendants.
function forbiddenNeedsIncompleteSource(
  root: PatternNodeV2,
  context: EvaluationContext,
): boolean {
  if (!context.incompleteSourceRefs.size) return false;
  const nodes: PatternNodeV2[] = [root];
  while (nodes.length) {
    const node = nodes.pop()!;
    if ('ref' in node && typeof node.ref === 'string' &&
      context.incompleteSourceRefs.has(node.ref)) return true;
    if ('child' in node && node.child) nodes.push(node.child);
    if ('children' in node && Array.isArray(node.children)) {
      nodes.push(...node.children);
    }
    if ('forbidden' in node && node.forbidden) nodes.push(node.forbidden);
  }
  return false;
}

async function evaluateNode(
  node: PatternNodeV2,
  context: EvaluationContext,
): Promise<PatternV2Candidate[]> {
  if (!consumeWork(context)) return [];
  const all = context.events;

  if (node.kind === 'event') {
    const values: PatternV2Candidate[] = [];
    const seen = new Set<string>();
    for (const event of eventsForRef(context, node.ref)) {
      if (!consumeWork(context)) break;
      // Ref is fixed for this event-node invocation, so physical identity
      // identifies the same candidate as its one-event signature. Skip
      // replayed copies *before* allocating and indexing a candidate.
      const key = eventIdentity(event);
      if (seen.has(key)) continue;
      seen.add(key);
      // Do not build an unbounded event-candidate array only to discard
      // it at the root or a later branch. Preserve a conservative
      // completeness signal when downstream filters need later events.
      if (values.length >= context.maxCandidates) {
        context.truncated = true;
        break;
      }
      values.push(candidateFromBindings({ [node.ref]: [event] }, all));
    }
    return values;
  }

  if (node.kind === 'anyOf') {
    // Parallel child materialization + flat() can retain
    // children.length * maxCandidates candidates before the dedupe cap.
    // Traverse in the same deterministic child order and stop after the
    // first extra unique outcome. A stopped branch is always truncated.
    const unionCandidates: PatternV2Candidate[] = [];
    const seen = new Set<string>();
    for (const child of node.children as PatternNodeV2[]) {
      if (context.workExhausted) break;
      const candidates = await evaluateNode(child, context);
      for (const candidate of candidates) {
        if (!consumeWork(context)) break;
        const key = candidateDedupeKey(candidate);
        if (seen.has(key)) continue;
        seen.add(key);
        if (unionCandidates.length >= context.maxCandidates) {
          context.truncated = true;
          return unionCandidates;
        }
        unionCandidates.push(candidate);
      }
      if (context.workExhausted) break;
    }
    return unionCandidates;
  }

  if (node.kind === 'allOf') {
    let current = [emptyCandidate()];
    for (const child of node.children as PatternNodeV2[]) {
      const next = await evaluateNode(child, context);
      const combined: PatternV2Candidate[] = [];
      const seen = new Set<string>();
      let truncated = false;
      // Generate only the first maxCandidates unique combinations.
      // Materializing every Cartesian pair before dedupe defeats the cap
      // and permits unbounded intermediate memory/work in a bounded run.
      combinations:
      for (const left of current) {
        for (const right of next) {
          if (!consumeWork(context)) break combinations;
          const merged = mergeCandidates(left, right, all);
          if (!merged) continue;
          const key = candidateDedupeKey(merged);
          if (seen.has(key)) continue;
          seen.add(key);
          if (combined.length >= context.maxCandidates) {
            truncated = true;
            break combinations;
          }
          combined.push(merged);
        }
      }
      context.truncated ||= truncated;
      current = combined;
      if (!current.length) break;
    }
    return current;
  }

  if (node.kind === 'sequence') {
    let current = await evaluateNode(node.children[0]!, context);

    for (const child of (node.children as PatternNodeV2[]).slice(1)) {
      const next = await evaluateNode(child, context);
      const combined: PatternV2Candidate[] = [];
      const seen = new Set<string>();
      let sequenceTruncated = false;

      // Selection rank depends on the *right* candidate and the child's
      // greedy/lazy preference, not on the current left-hand anchor.
      // Sort once per child: the previous per-left map/filter/sort built an
      // O(right) temporary array and re-sorted it for every left candidate
      // even when maxCandidates let only the first few joins survive.
      const emptyPreference =
        (child.kind === 'optional' ||
          (child.kind === 'repeat' && child.min === 0))
          ? child.mode
          : 'lazy';
      const rankedSuccessors = next
        .map((candidate, rank) => ({ candidate, rank }))
        .sort((a, b) => {
          const aEmpty = a.candidate.events.length === 0;
          const bEmpty = b.candidate.events.length === 0;
          if (aEmpty !== bEmpty) {
            return emptyPreference === 'greedy'
              ? Number(aEmpty) - Number(bEmpty)
              : Number(bEmpty) - Number(aEmpty);
          }
          if (!aEmpty && !bEmpty) {
            return a.candidate.startIndex - b.candidate.startIndex ||
              a.rank - b.rank;
          }
          return a.rank - b.rank;
        });

      // As with allOf, avoid materializing every selected sequence pair.
      // Stop at maxCandidates + 1 unique completions, preserving the same
      // priority order as the formerly per-left sorted compatible subset.
      sequenceJoin:
      for (const left of current) {
        for (const { candidate: right } of rankedSuccessors) {
          if (!consumeWork(context)) break sequenceJoin;
          if (right.events.length && left.events.length) {
            if (right.startIndex <= left.endIndex) continue;
            if (node.contiguity === 'next' &&
              right.startIndex !== left.endIndex + 1) continue;
          }
          // followedBy selects only the first compatible right, even if
          // mergeCandidates rejects it: do not fall through to a later one.
          const firstOnly = node.contiguity === 'followedBy';
          const merged = mergeCandidates(left, right, all);
          if (!merged) {
            if (firstOnly) break;
            continue;
          }
          const key = [
            candidateSignature(merged),
            merged.pendingUntil ?? '-',
          ].join('#');
          if (seen.has(key)) {
            if (firstOnly) break;
            continue;
          }
          seen.add(key);
          if (combined.length >= context.maxCandidates) {
            sequenceTruncated = true;
            break sequenceJoin;
          }
          combined.push(merged);
          if (firstOnly) break;
        }
      }

      context.truncated ||= sequenceTruncated;
      current = combined;
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
    let localRepeatLimitReached = false;

    // maxCandidates bounds emitted results, not the number of dead-end
    // recursive paths. Bound exploration separately so nested/high-fanout
    // repeat patterns cannot silently consume unbounded work while
    // returning zero matches. Exceeding the search budget is *incomplete*,
    // never a conclusive no-match.
    const maxExplorationSteps = context.maxCandidates * 32;
    const maxSearchDepth = 256;
    let explorationSteps = 0;
    const consumeStep = (): boolean => {
      explorationSteps += 1;
      if (explorationSteps <= maxExplorationSteps) return true;
      localRepeatLimitReached = true;
      context.truncated = true;
      return false;
    };

    if (node.min > units.length) return [];

    if (node.min === 0) {
      output.push({ candidate: emptyCandidate(), count: 0 });
    }

    const walk = (
      start: number,
      selected: PatternV2Candidate,
      count: number,
    ) => {
      if (localRepeatLimitReached) return;
      // Even perfect compatibility cannot provide enough remaining units.
      if (count + units.length - start < node.min) return;
      if (count >= node.min) {
        output.push({ candidate: selected, count });
        if (output.length >= context.maxCandidates) {
          localRepeatLimitReached = true;
          context.truncated = true;
          return;
        }
      }
      if (count >= max || start >= units.length) return;
      if (count >= maxSearchDepth) {
        // Keep the result explicitly inconclusive rather than overflowing
        // the JavaScript call stack on a valid, high-minimum repeat.
        localRepeatLimitReached = true;
        context.truncated = true;
        return;
      }

      const compatibleIndexes: number[] = [];
      for (let index = start; index < units.length; index += 1) {
        if (!consumeWork(context) || !consumeStep()) return;
        const unit = units[index]!;
        if (
          selected.events.length &&
          unit.startIndex <= selected.endIndex
        ) {
          continue;
        }
        if (
          selected.events.length &&
          node.contiguity === 'consecutive' &&
          unit.startIndex !== selected.endIndex + 1
        ) {
          break;
        }
        compatibleIndexes.push(index);
        if (
          selected.events.length &&
          node.contiguity === 'relaxed'
        ) {
          break;
        }
      }

      for (const index of compatibleIndexes) {
        if (!consumeWork(context) || !consumeStep()) return;
        const unit = units[index]!;
        const merged = mergeCandidates(selected, unit, all);
        if (!merged) continue;
        walk(index + 1, merged, count + 1);
        // A prior child (e.g. optional) may be truncated even when all
        // its retained non-empty units are still usable. Only this
        // repeat's own enumeration cap can stop this traversal.
        if (localRepeatLimitReached) return;
      }
    };

    walk(0, emptyCandidate(), 0);

    output.sort((a, b) =>
      node.mode === 'greedy'
        ? b.count - a.count || a.candidate.startIndex - b.candidate.startIndex
        : a.count - b.count || a.candidate.startIndex - b.candidate.startIndex
    );

    const limited = dedupe(
      output.map((entry) => entry.candidate),
      context.maxCandidates,
    );
    context.truncated ||= limited.truncated;
    return limited.values;
  }

  if (node.kind === 'optional') {
    const child = await evaluateNode(node.child, context);
    const candidates = node.mode === 'greedy'
      ? [...child, emptyCandidate()]
      : [emptyCandidate(), ...child];
    const limited = dedupe(candidates, context.maxCandidates);
    // Returning the candidate slice alone can falsely signal a complete
    // negative outcome when an optional branch was discarded by the cap.
    context.truncated ||= limited.truncated;
    return limited.values;
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
    if (context.incompleteSourceRefs.has(node.ref)) {
      const bases = await evaluateNode(node.child, context);
      if (context.truncated) return [];
      for (const base of bases) {
        if (!base.events.length || !consumeWork(context)) break;
        if (context.incompletePending.length >= context.maxCandidates) {
          context.truncated = true;
          break;
        }
        // Snapshot negation has no future finality interval. Retain a
        // stable *already due* retry, keyed by source-event time, which
        // remains pending while the transport gap is unresolved.
        context.incompletePending.push({
          ...base, pendingUntil: base.events.at(-1)!.occurredAt,
        });
      }
      context.truncated = true;
      return [];
    }
    const forbidden = eventsForRef(context, node.ref);
    const children = await evaluateNode(node.child, context);
    if (context.truncated) return [];
    const complete: PatternV2Candidate[] = [];
    for (const candidate of children) {
      let blocked = false;
      for (const event of forbidden) {
        // Stop *both* loops at the first exhausted work unit. A false
        // .some() callback would keep scanning millions of times.
        if (!consumeWork(context)) return [];
        const index = indexFor(context.events, event);
        if (index >= candidate.startIndex &&
            index <= candidate.endIndex) {
          blocked = true;
          break;
        }
      }
      if (!blocked) complete.push(candidate);
    }
    return complete;
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
    const refEvents = distinctEventsForRef(context, node.ref);
    if (refEvents.length < node.atLeast) return [];
    const child = await evaluateNode(node.child, context);
    return attachBindingsBounded(
      context, child, node.ref, refEvents.slice(0, node.atLeast),
    );
  }

  if (node.kind === 'distinct') {
    const chosen: TriggerSourceEvent[] = [];
    const values = new Set<string>();
    for (const event of eventsForRef(context, node.ref)) {
      const value = readOwnEventPath(event.data, node.path);
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
    const child = await evaluateNode(node.child, context);
    return attachBindingsBounded(context, child, node.ref, chosen);
  }

  if (node.kind === 'rate') {
    const refEvents = distinctEventsForRef(context, node.ref);
    if (!refEvents.length) return [];
    const latest = Math.max(
      ...refEvents.map((event) => Date.parse(event.occurredAt)),
    );
    const inWindow = refEvents.filter(
      (event) => latest - Date.parse(event.occurredAt) <= node.perMs,
    );
    if (inWindow.length < node.atLeast) return [];
    const child = await evaluateNode(node.child, context);
    return attachBindingsBounded(
      context, child, node.ref, inWindow.slice(-node.atLeast),
    );
  }

  if (node.kind === 'debounce') {
    const refEvents = eventsForRef(context, node.ref);
    const latest = refEvents.at(-1);
    if (!latest) return [];
    const dueAt = Date.parse(latest.occurredAt) + node.forMs;
    const finalAt = dueAt + context.allowedLatenessMs;
    const child = await evaluateNode(node.child, context);
    return attachBindingsBounded(context, child, node.ref, [latest])
      .map((augmented) => ({
        ...augmented,
        ...(context.now.getTime() < finalAt
          ? { pendingUntil: new Date(finalAt).toISOString() }
          : {}),
      }));
  }

  if (node.kind === 'absence') {
    if (context.incompleteSourceRefs.has(node.ref)) {
      const bases = await evaluateNode(node.child, context);
      if (context.truncated) return [];
      for (const base of bases) {
        if (!consumeWork(context)) break;
        if (context.incompletePending.length >= context.maxCandidates) {
          context.truncated = true;
          break;
        }
        const anchor = latestBoundEvent(base, node.afterRef);
        if (!anchor) continue;
        const due = absenceNodeDueAt(node, anchor);
        context.incompletePending.push({
          ...base,
          pendingUntil: new Date(
            due.getTime()+context.allowedLatenessMs,
          ).toISOString(),
        });
      }
      context.truncated = true;
      return [];
    }
    const bases = await evaluateNode(node.child, context);
    const forbidden = eventsForRef(context, node.ref);
    const output: PatternV2Candidate[] = [];
    // An incomplete child cannot establish a negative absence fact.
    if (context.truncated) return [];

    for (const base of bases) {
      const anchor = latestBoundEvent(base, node.afterRef);
      if (!anchor) continue;
      const due = absenceNodeDueAt(node, anchor);
      const finalAt = due.getTime() + context.allowedLatenessMs;
      const anchorMs = Date.parse(anchor.occurredAt);
      let blocked = false;
      for (const event of forbidden) {
        if (!consumeWork(context)) return [];
        const at = Date.parse(event.occurredAt);
        if (at >= anchorMs && at <= due.getTime()) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      output.push({
        ...base,
        ...(context.now.getTime() < finalAt
          ? { pendingUntil: new Date(finalAt).toISOString() }
          : {}),
      });
    }

    return output;
  }

  if (node.kind === 'notNext') {
    if (forbiddenNeedsIncompleteSource(node.forbidden, context)) {
      const bases = await evaluateNode(node.child, context);
      if (context.truncated) return [];
      for (const base of bases) {
        if (!base.events.length || !consumeWork(context)) break;
        if (context.incompletePending.length >= context.maxCandidates) {
          context.truncated = true;
          break;
        }
        context.incompletePending.push({
          ...base, pendingUntil: base.events.at(-1)!.occurredAt,
        });
      }
      context.truncated = true;
      return [];
    }
    const bases = await evaluateNode(node.child, context);
    const forbidden = await evaluateNode(node.forbidden, context);
    // A capped forbidden branch may omit the exact event that blocks a
    // negative match. The host can persist returned matches even when
    // truncated=true, so never emit negative matches from incomplete
    // evidence. A prior child truncation also warrants a fail-closed exit.
    if (context.truncated) return [];
    const allowed: PatternV2Candidate[] = [];
    for (const base of bases) {
      if (!base.events.length) continue;
      let blocked = false;
      for (const candidate of forbidden) {
        if (!consumeWork(context)) return [];
        if (candidate.events.length &&
            candidate.startIndex === base.endIndex + 1) {
          blocked = true;
          break;
        }
      }
      if (!blocked) allowed.push(base);
    }
    return allowed;
  }

  if (node.kind === 'notFollowedBy') {
    if (forbiddenNeedsIncompleteSource(node.forbidden, context)) {
      const bases = await evaluateNode(node.child, context);
      if (context.truncated) return [];
      // Preserve an actual durable timer for an anchor created DURING
      // a delivery gap. It is only a reevaluation hint, NEVER a match.
      for (const base of bases) {
        if (!base.events.length) continue;
        if (!consumeWork(context)) break;
        if (context.incompletePending.length >= context.maxCandidates) {
          context.truncated = true;
          break;
        }
        const anchor = Date.parse(base.events.at(-1)!.occurredAt);
        const deadline = anchor + node.withinMs + context.allowedLatenessMs;
        context.incompletePending.push({
          ...base, pendingUntil: new Date(deadline).toISOString(),
        });
      }
      context.truncated = true;
      return [];
    }
    const bases = await evaluateNode(node.child, context);
    const forbidden = await evaluateNode(node.forbidden, context);
    // Never finalize or expose a negative result if the full set of
    // potentially disqualifying evidence was not evaluated.
    if (context.truncated) return [];
    const output: PatternV2Candidate[] = [];

    for (const base of bases) {
      if (!base.events.length) continue;
      const anchor = Date.parse(base.events.at(-1)!.occurredAt);
      const dueAt = anchor + node.withinMs;
      const finalAt = dueAt + context.allowedLatenessMs;
      let blocked = false;
      for (const candidate of forbidden) {
        if (!consumeWork(context)) return [];
        if (!candidate.events.length) continue;
        const startedAt = Date.parse(candidate.events[0]!.occurredAt);
        const completedAt = Date.parse(candidate.events.at(-1)!.occurredAt);
        if (startedAt > anchor && completedAt <= dueAt) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      output.push({
        ...base,
        ...(context.now.getTime() < finalAt
          ? { pendingUntil: new Date(finalAt).toISOString() }
          : {}),
      });
    }
    return output;
  }

  const child = await evaluateNode(node.child, context);

  if (node.kind === 'compare') {
    const cost = arithmeticNodeCost(node.left) +
      (node.right ? arithmeticNodeCost(node.right) : 0);
    const selected: PatternV2Candidate[] = [];
    for (const candidate of child) {
      // A saturated budget is inconclusive, not a definitive no-match.
      // Negative ancestors already fail closed on context.truncated.
      if (!consumeWork(context, cost)) break;
      if (compareValue(evaluateValue(node.left, candidate), node, candidate)) {
        selected.push(candidate);
      }
    }
    return selected;
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
    if (!context.evaluator) {
      if (node.execution.onUnavailable === 'reject') continue;
      throw new Error(
        `Semantic node ${node.id} requires a SemanticEvaluator`,
      );
    }
    const localCacheKey = [
      node.id,
      candidateSignature(candidate),
      node.instruction,
      JSON.stringify(node.input),
      node.matchThreshold,
      node.rejectThreshold,
      node.uncertain,
    ].join(':');
    const durableCacheKey = node.execution.cache
      ? durableSemanticCacheKey(context, node, candidate)
      : null;

    let decision = context.semanticCache.get(localCacheKey);
    if (decision) {
      context.semanticCacheHits += 1;
    }

    if (
      !decision &&
      durableCacheKey &&
      context.durableSemanticCache
    ) {
      decision =
        await context.durableSemanticCache.get(durableCacheKey) ??
        undefined;
      if (decision) {
        context.semanticCacheHits += 1;
        context.semanticCache.set(localCacheKey, decision);
      }
    }

    if (!decision) {
      // This budget caps *new evaluator calls*, not already-proven cached
      // decisions. A zero-call run can still resolve a durable cache hit.
      if (context.semanticEvaluations >= context.maxSemanticEvaluations) {
        // A later candidate may already have a valid cached decision.
        // Continue scanning rather than discarding known outcomes; this
        // evaluation remains incomplete because the miss was unresolved.
        context.truncated = true;
        continue;
      }
      context.semanticCacheMisses += 1;
      context.semanticEvaluations += 1;
      decision = await withTimeout(
        new SemanticConditionEngine(
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
        ),
        node.execution.timeoutMs,
        `Semantic node ${node.id}`,
      );
      if (node.execution.cache) {
        context.semanticCache.set(localCacheKey, decision);
        if (
          durableCacheKey &&
          context.durableSemanticCache
        ) {
          await context.durableSemanticCache.set(
            durableCacheKey,
            decision,
          );
        }
      }
    }

    context.semanticTrace.push({
      nodeId: node.id,
      candidateSignature: candidateSignature(candidate),
      decision,
    });

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
  allowedLatenessMs = 0,
  semanticCache = null,
  semanticCacheNamespace = '',
  semanticContextRevision = '',
  semanticCacheTtlMs = null,
  incompleteSourceRefs = new Set<string>(),
}: {
  definition: PatternAstV2Definition;
  events: TriggerSourceEvent[];
  evaluator?: SemanticEvaluator | null;
  now?: Date;
  allowedLatenessMs?: number;
  semanticCache?: PatternV2SemanticCache | null;
  semanticCacheNamespace?: string;
  semanticContextRevision?: string;
  semanticCacheTtlMs?: number | null;
  incompleteSourceRefs?: ReadonlySet<string>;
}): Promise<PatternV2Evaluation> {
  if(typeof semanticContextRevision !== 'string' ||
     semanticContextRevision.length > 128 ||
     (semanticCacheTtlMs !== null &&
      (!Number.isSafeInteger(semanticCacheTtlMs) ||
       semanticCacheTtlMs < 1000 || semanticCacheTtlMs > 86400000))) {
    throw new RangeError('Invalid semantic context revision or cache TTL');
  }
  // Bounded preflight before input cloning/sort or AST recursion.
  if (events.length > MAX_EVALUATION_INPUT_EVENTS ||
    !boundedAst(definition.root)) {
    return {
      matches: [], pending: [], semanticEvaluations: 0,
      semanticCacheHits: 0, semanticCacheMisses: 0,
      semanticTrace: [], truncated: true,
    };
  }
  const ordered = [...events].sort(eventOrder);
  const eventsByRef = new Map<string, TriggerSourceEvent[]>();
  for (const event of ordered) {
    const bucket = eventsByRef.get(event.clauseId) ?? [];
    bucket.push(event);
    eventsByRef.set(event.clauseId, bucket);
  }
  const context: EvaluationContext = {
    events: ordered,
    eventsByRef,
    incompleteSourceRefs,
    incompletePending: [],
    evaluator,
    now,
    maxCandidates: definition.execution.maxCandidates,
    maxSemanticEvaluations: definition.execution.maxSemanticEvaluations,
    semanticEvaluations: 0,
    semanticCacheHits: 0,
    semanticCacheMisses: 0,
    truncated: false,
    workSteps: 0,
    maxWorkSteps: Math.min(MAX_EVALUATION_WORK_STEPS,
      Math.max(4_096, definition.execution.maxCandidates * 128)),
    workExhausted: false,
    semanticCache: new Map(),
    durableSemanticCache: semanticCache,
    semanticCacheNamespace,
    semanticContextRevision,
    semanticCacheTtlMs,
    semanticTrace: [],
    allowedLatenessMs,
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
    ...(context.incompletePending.length
      ? { incompletePending: context.incompletePending } : {}),
    semanticEvaluations: context.semanticEvaluations,
    semanticCacheHits: context.semanticCacheHits,
    semanticCacheMisses: context.semanticCacheMisses,
    semanticTrace: context.semanticTrace,
    truncated: context.truncated,
  };
}

export function patternV2CandidateSignature(
  candidate: PatternV2Candidate,
): string {
  return candidateSignature(candidate);
}
