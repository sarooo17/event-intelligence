import type { LifecycleState } from './schemas.js';

const ALLOWED: Record<LifecycleState, ReadonlySet<LifecycleState>> = {
  wake_queued: new Set(['wake_delivered', 'dead_letter']),
  wake_delivered: new Set(),
  dead_letter: new Set(),
};

export function canTransition(
  from: LifecycleState,
  to: LifecycleState,
): boolean {
  return ALLOWED[from].has(to);
}

export function assertTransition(
  from: LifecycleState,
  to: LifecycleState,
): void {
  if (!canTransition(from, to)) {
    throw new Error(
      `Invalid event-intelligence lifecycle transition: ${from} -> ${to}`,
    );
  }
}

export function allowedTransitions(
  from: LifecycleState,
): LifecycleState[] {
  return [...ALLOWED[from]];
}
