export class WakeRetryScheduler {
  constructor({
    store,
    resolveCoordinator,
    intervalMs = 1000,
    now = () => new Date(),
    observability = null,
    orphanReconcileIntervalMs = 30000,
    orphanMatchLimit = 32,
  }) {
    this.store = store;
    this.resolveCoordinator = resolveCoordinator;
    this.intervalMs = Math.max(100, Number(intervalMs) || 1000);
    this.now = now;
    this.observability = observability;
    this.timer = null;
    this.running = false;
    this.orphanReconcileIntervalMs = Math.max(1000, Number(orphanReconcileIntervalMs) || 30000);
    this.orphanMatchLimit = Math.max(1, Math.min(100, Number(orphanMatchLimit) || 32));
    this.lastOrphanScanAt = -Infinity;
    this.orphanCursor = '';
  }

  async runDue() {
    if (this.running) return [];
    this.running = true;
    try {
      const due = await this.store.listDueWakeDeliveries(this.now().toISOString());
      const outcomes = [];

      for (const delivery of due) {

        const coordinator = this.resolveCoordinator(delivery.runtime);
        if (!coordinator) {
          outcomes.push({
            wakeId: delivery.wakeId,
            status: 'runtime_unconfigured',
          });
          continue;
        }

        const match = (await this.store.listTriggerMatches(delivery.triggerId))
          .filter((candidate) => candidate.matchId === delivery.matchId)
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];

        if (!match) {
          outcomes.push({
            wakeId: delivery.wakeId,
            status: 'match_missing',
          });
          continue;
        }

        const result = await coordinator.deliverMatched(match);
        outcomes.push({
          wakeId: delivery.wakeId,
          matchId: delivery.matchId,
          status: result.status,
        });
      }

      // A real process may die *after* a durable Pattern match commits
      // but *before* ensureWakeDelivery() inserts a retriable wake.
      // listDueWakeDeliveries() cannot see that crash boundary at all.
      // Scan only on the slower recovery cadence and only when the store
      // explicitly supports a bounded authoritative orphan projection.
      const nowMs = this.now().getTime();
      if (typeof this.store.listOrphanedMatchedWakeCandidates === 'function' &&
          nowMs - this.lastOrphanScanAt >= this.orphanReconcileIntervalMs) {
        this.lastOrphanScanAt = nowMs;
        const orphaned = await this.store.listOrphanedMatchedWakeCandidates({
          afterMatchId: this.orphanCursor,
          limit: this.orphanMatchLimit,
        });
        this.orphanCursor = orphaned.length === this.orphanMatchLimit
          ? orphaned[orphaned.length - 1].matchId
          : '';
        for (const match of orphaned) {
          // Re-read scope-local definition and revocation state right at
          // the moment of recovery; do not awaken a paused/deleted trigger
          // just because it matched before its authorization changed.
          const definition = typeof this.store.getTrigger === 'function'
            ? await this.store.getTrigger(match.triggerId, match.triggerVersion)
            : (await this.store.listTriggers()).find(row =>
                row.triggerId === match.triggerId &&
                row.version === match.triggerVersion);
          const state = typeof this.store.getTriggerState === 'function'
            ? await this.store.getTriggerState(match.triggerId, match.triggerVersion)
            : null;
          const lifecycle = definition?.lifecycle ?? {};
          const expiresAt = lifecycle.expiresAt
            ? Date.parse(lifecycle.expiresAt) : Number.POSITIVE_INFINITY;
          const leaseUntil = lifecycle.leaseUntil
            ? Date.parse(lifecycle.leaseUntil) : Number.POSITIVE_INFINITY;
          const count = state?.fireCount ?? 0;
          if (!definition?.target || (state && state.status !== 'active') ||
              nowMs > Math.min(expiresAt, leaseUntil) ||
              (lifecycle.oneShot === true && count >= 1) ||
              (lifecycle.maxFirings !== undefined && count >= lifecycle.maxFirings)) {
            outcomes.push({ matchId: match.matchId, status: 'recovery_not_authorized' });
            continue;
          }
          const coordinator = this.resolveCoordinator(definition.target.runtime);
          if (!coordinator) {
            outcomes.push({ matchId: match.matchId, status: 'runtime_unconfigured' });
            continue;
          }
          const result = await coordinator.deliverMatched(match);
          outcomes.push({
            matchId: match.matchId, wakeId: result.wake?.wakeId ?? null,
            status: result.status,
          });
        }
      }

      return outcomes;
    } finally {
      this.running = false;
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runDue().catch((error) => {
        if (this.observability?.enabled) {
          void this.observability.emit({
            event: 'ei.scheduler.wake_retry_failed',
            level: 'error',
            error,
          });
          return;
        }
        console.error(JSON.stringify({
          message: 'wake_retry_scheduler_error',
          error: error instanceof Error ? error.message : String(error),
        }));
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async drain() {
    while (this.running) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  async close() {
    this.stop();
    await this.drain();
  }
}
