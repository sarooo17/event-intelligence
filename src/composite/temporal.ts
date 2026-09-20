import type {
  CompositeTriggerDefinition,
  TemporalCondition,
  TriggerMatchRecord,
  TriggerSourceEvent,
} from '../intelligenceProtocol/triggerSchemas.js';

export interface TemporalPendingDeadline {
  conditionId: string;
  dueAt: string;
}

export interface TemporalEvaluation {
  outcome: 'satisfied' | 'pending' | 'blocked';
  pendingDeadlines: TemporalPendingDeadline[];
  conditionStates: Array<{
    conditionId: string;
    kind: TemporalCondition['kind'];
    status: 'satisfied' | 'pending' | 'blocked';
    dueAt?: string;
    reason?: string;
  }>;
}

function getByPath(source: unknown, path: string): unknown {
  let current = source;
  for (const part of path.split('.')) {
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current)
    ) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function eventsFor(
  record: TriggerMatchRecord,
  ref: string,
): TriggerSourceEvent[] {
  return record.sourceEvents
    .filter((event) => event.clauseId === ref)
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
}

function latestEvent(
  record: TriggerMatchRecord,
  ref: string,
): TriggerSourceEvent | null {
  return eventsFor(record, ref).at(-1) ?? null;
}

function parseClock(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour! * 60 + minute!;
}

const WEEKDAY_TO_ISO: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

export function zonedParts(
  timestamp: string | Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
  date: string;
} {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const raw = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const year = Number(raw.year);
  const month = Number(raw.month);
  const day = Number(raw.day);
  return {
    year,
    month,
    day,
    hour: Number(raw.hour),
    minute: Number(raw.minute),
    second: Number(raw.second),
    weekday: WEEKDAY_TO_ISO[String(raw.weekday)]!,
    date: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

export function localDateTimeToUtc(
  date: { year: number; month: number; day: number },
  clock: string,
  timeZone: string,
): Date {
  const [hour, minute] = clock.split(':').map(Number);
  const desiredAsUtc = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    hour,
    minute,
    0,
    0,
  );

  let guess = desiredAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(new Date(guess), timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
      0,
    );
    const delta = desiredAsUtc - actualAsUtc;
    if (delta === 0) break;
    guess += delta;
  }

  return new Date(guess);
}

function calendarMatches(
  condition: Extract<TemporalCondition, { kind: 'calendar' }>,
  event: TriggerSourceEvent,
): boolean {
  const parts = zonedParts(event.occurredAt, condition.timezone);
  const minutes = parts.hour * 60 + parts.minute;

  if (condition.weekdays && !condition.weekdays.includes(parts.weekday)) {
    return false;
  }
  if (condition.dates && !condition.dates.includes(parts.date)) {
    return false;
  }
  if (
    condition.dateRange &&
    (parts.date < condition.dateRange.start ||
      parts.date > condition.dateRange.end)
  ) {
    return false;
  }
  if (
    condition.dayOfMonth &&
    !condition.dayOfMonth.includes(parts.day)
  ) {
    return false;
  }

  if (condition.before && condition.after) {
    const before = parseClock(condition.before);
    const after = parseClock(condition.after);
    if (after <= before) {
      if (minutes < after || minutes > before) return false;
    } else {
      if (!(minutes >= after || minutes <= before)) return false;
    }
  } else {
    if (condition.before && minutes > parseClock(condition.before)) {
      return false;
    }
    if (condition.after && minutes < parseClock(condition.after)) {
      return false;
    }
  }

  return true;
}

function absenceDueAt(
  condition: Extract<TemporalCondition, { kind: 'absence' }>,
  anchor: TriggerSourceEvent,
): Date {
  const anchorMs = Date.parse(anchor.occurredAt);
  if (condition.forMs) {
    return new Date(anchorMs + condition.forMs);
  }

  const zone = condition.timezone!;
  const parts = zonedParts(anchor.occurredAt, zone);
  const due = localDateTimeToUtc(parts, condition.untilLocalTime!, zone);
  return due.getTime() < anchorMs ? new Date(anchorMs) : due;
}

function state(
  condition: TemporalCondition,
  status: 'satisfied' | 'pending' | 'blocked',
  extra: { dueAt?: string; reason?: string } = {},
) {
  return {
    conditionId: condition.id,
    kind: condition.kind,
    status,
    ...extra,
  };
}

export function evaluateTemporalConditions(
  definition: CompositeTriggerDefinition,
  record: TriggerMatchRecord,
  now: Date,
): TemporalEvaluation {
  const states: TemporalEvaluation['conditionStates'] = [];
  const pendingDeadlines: TemporalPendingDeadline[] = [];

  for (const condition of definition.temporal ?? []) {
    if (condition.kind === 'calendar') {
      const event = latestEvent(record, condition.ref);
      if (!event) {
        states.push(state(condition, 'pending', {
          reason: 'referenced event has not occurred',
        }));
        continue;
      }
      states.push(
        calendarMatches(condition, event)
          ? state(condition, 'satisfied')
          : state(condition, 'blocked', {
              reason: 'event is outside the configured calendar window',
            }),
      );
      continue;
    }

    if (condition.kind === 'not' || condition.kind === 'unless') {
      const exists = eventsFor(record, condition.ref).length > 0;
      states.push(
        exists
          ? state(condition, 'blocked', {
              reason: `${condition.ref} occurred`,
            })
          : state(condition, 'satisfied'),
      );
      continue;
    }

    if (condition.kind === 'after') {
      const event = latestEvent(record, condition.ref);
      const anchor = latestEvent(record, condition.afterRef);
      if (!event || !anchor) {
        states.push(state(condition, 'pending', {
          reason: 'ordering events are incomplete',
        }));
      } else if (Date.parse(event.occurredAt) > Date.parse(anchor.occurredAt)) {
        states.push(state(condition, 'satisfied'));
      } else {
        states.push(state(condition, 'blocked', {
          reason: `${condition.ref} did not occur after ${condition.afterRef}`,
        }));
      }
      continue;
    }

    if (condition.kind === 'until') {
      const event = latestEvent(record, condition.ref);
      const boundary = latestEvent(record, condition.beforeRef);
      if (!event || !boundary) {
        states.push(state(condition, 'pending', {
          reason: 'ordering events are incomplete',
        }));
      } else if (Date.parse(event.occurredAt) <= Date.parse(boundary.occurredAt)) {
        states.push(state(condition, 'satisfied'));
      } else {
        states.push(state(condition, 'blocked', {
          reason: `${condition.ref} occurred after ${condition.beforeRef}`,
        }));
      }
      continue;
    }

    if (condition.kind === 'threshold') {
      const count = eventsFor(record, condition.ref).length;
      states.push(
        count >= condition.atLeast
          ? state(condition, 'satisfied')
          : state(condition, 'pending', {
              reason: `${count}/${condition.atLeast} occurrences`,
            }),
      );
      continue;
    }

    if (condition.kind === 'distinct') {
      const values = new Set(
        eventsFor(record, condition.ref)
          .map((event) => getByPath(event.data, condition.path))
          .filter((value) =>
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean'
          )
          .map(String),
      );
      states.push(
        values.size >= condition.atLeast
          ? state(condition, 'satisfied')
          : state(condition, 'pending', {
              reason: `${values.size}/${condition.atLeast} distinct values`,
            }),
      );
      continue;
    }

    if (condition.kind === 'rate') {
      const events = eventsFor(record, condition.ref);
      if (!events.length) {
        states.push(state(condition, 'pending', {
          reason: 'no events in rate window',
        }));
        continue;
      }
      const end = Math.max(
        now.getTime(),
        Date.parse(events.at(-1)!.occurredAt),
      );
      const count = events.filter(
        (event) => end - Date.parse(event.occurredAt) <= condition.perMs,
      ).length;
      states.push(
        count >= condition.atLeast
          ? state(condition, 'satisfied')
          : state(condition, 'pending', {
              reason: `${count}/${condition.atLeast} occurrences in rate window`,
            }),
      );
      continue;
    }

    if (condition.kind === 'debounce') {
      const event = latestEvent(record, condition.ref);
      if (!event) {
        states.push(state(condition, 'pending', {
          reason: 'debounced event has not occurred',
        }));
        continue;
      }
      const dueAt = new Date(
        Date.parse(event.occurredAt) + condition.forMs,
      ).toISOString();
      if (now.getTime() >= Date.parse(dueAt)) {
        states.push(state(condition, 'satisfied', { dueAt }));
      } else {
        states.push(state(condition, 'pending', {
          dueAt,
          reason: 'waiting for quiet period',
        }));
        pendingDeadlines.push({
          conditionId: condition.id,
          dueAt,
        });
      }
      continue;
    }

    if (condition.kind === 'absence') {
      const anchor = latestEvent(record, condition.afterRef);
      if (!anchor) {
        states.push(state(condition, 'pending', {
          reason: `waiting for anchor ${condition.afterRef}`,
        }));
        continue;
      }

      const due = absenceDueAt(condition, anchor);
      const dueAt = due.toISOString();
      const anchorMs = Date.parse(anchor.occurredAt);
      const disqualifying = eventsFor(record, condition.ref)
        .some((event) => {
          const at = Date.parse(event.occurredAt);
          return at >= anchorMs && at <= due.getTime();
        });

      if (disqualifying) {
        states.push(state(condition, 'blocked', {
          dueAt,
          reason: `${condition.ref} occurred before the absence deadline`,
        }));
      } else if (now.getTime() >= due.getTime()) {
        states.push(state(condition, 'satisfied', { dueAt }));
      } else {
        states.push(state(condition, 'pending', {
          dueAt,
          reason: 'absence window is still open',
        }));
        pendingDeadlines.push({
          conditionId: condition.id,
          dueAt,
        });
      }
    }
  }

  if (states.some((entry) => entry.status === 'blocked')) {
    return {
      outcome: 'blocked',
      pendingDeadlines,
      conditionStates: states,
    };
  }
  if (states.some((entry) => entry.status === 'pending')) {
    return {
      outcome: 'pending',
      pendingDeadlines,
      conditionStates: states,
    };
  }
  return {
    outcome: 'satisfied',
    pendingDeadlines,
    conditionStates: states,
  };
}
