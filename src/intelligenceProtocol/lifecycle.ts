import type { LifecycleState } from './schemas.js';

const ALLOWED: Record<LifecycleState, ReadonlySet<LifecycleState>> = {
  received: new Set(['duplicate', 'evaluating', 'matched', 'failed']),
  duplicate: new Set(),
  evaluating: new Set(['matched', 'rejected', 'escalated', 'failed']),
  matched: new Set(['wake_queued', 'failed']),
  rejected: new Set(),
  escalated: new Set(['wake_queued', 'rejected', 'failed']),
  wake_queued: new Set(['wake_delivered', 'dead_letter', 'failed']),
  wake_delivered: new Set(['handled', 'dead_letter', 'failed']),
  handled: new Set(),
  failed: new Set(['dead_letter']),
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
    throw new Error(`Invalid event-intelligence lifecycle transition: ${from} -> ${to}`);
  }
}

export function allowedTransitions(from: LifecycleState): LifecycleState[] {
  return [...ALLOWED[from]];
}
