export class WakeRetryScheduler {
  constructor({
    store,
    resolveCoordinator,
    eventProcessor = null,
    intervalMs = 1000,
    now = () => new Date(),
  }) {
    this.store = store;
    this.resolveCoordinator = resolveCoordinator;
    this.eventProcessor = eventProcessor;
    this.intervalMs = Math.max(100, Number(intervalMs) || 1000);
    this.now = now;
    this.timer = null;
    this.running = false;
  }

  async runDue() {
    if (this.running) return [];
    this.running = true;
    try {
      const due = this.store.listDueWakeDeliveries(this.now().toISOString());
      const outcomes = [];

      for (const delivery of due) {
        if (delivery.sourceType === 'event') {
          if (!this.eventProcessor || typeof this.eventProcessor.retryWake !== 'function') {
            outcomes.push({
              wakeId: delivery.wakeId,
              status: 'event_processor_unconfigured',
            });
            continue;
          }
          const result = await this.eventProcessor.retryWake(delivery.wakeId);
          outcomes.push({
            wakeId: delivery.wakeId,
            status: result.status,
          });
          continue;
        }

        const coordinator = this.resolveCoordinator(delivery.runtime);
        if (!coordinator) {
          outcomes.push({
            wakeId: delivery.wakeId,
            status: 'runtime_unconfigured',
          });
          continue;
        }

        const match = this.store.listTriggerMatches(delivery.triggerId)
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
