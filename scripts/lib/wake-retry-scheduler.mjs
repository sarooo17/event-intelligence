export class WakeRetryScheduler {
  constructor({
    store,
    resolveCoordinator,
    intervalMs = 1000,
    now = () => new Date(),
    observability = null,
  }) {
    this.store = store;
    this.resolveCoordinator = resolveCoordinator;
    this.intervalMs = Math.max(100, Number(intervalMs) || 1000);
    this.now = now;
    this.observability = observability;
    this.timer = null;
    this.running = false;
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
          status: result.status,
        });
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
