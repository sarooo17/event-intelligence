export class TemporalDeadlineScheduler {
  constructor({
    store,
    compositeEventConsumer,
    now = () => new Date(),
    intervalMs = 1000,
  }) {
    this.store = store;
    this.compositeEventConsumer = compositeEventConsumer;
    this.now = now;
    this.intervalMs = Math.max(250, Number(intervalMs) || 1000);
    this.timer = null;
    this.running = false;
  }

  async runDue() {
    if (this.running) return [];
    this.running = true;

    try {
      const now = this.now();
      const due = this.store.listDueTemporalDeadlines(now.toISOString());
      const outcomes = [];

      for (const deadline of due) {
        const latest = this.store.getTemporalDeadline(deadline.deadlineId);
        if (!latest || latest.status !== 'pending') continue;

        const match = this.store.listTriggerMatches(deadline.triggerId)
          .filter((record) => record.matchId === deadline.matchId)
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];

        if (
          !match ||
          match.status === 'expired' ||
          match.status === 'matched' ||
          match.status === 'emitted' ||
          match.status === 'fired'
        ) {
          await this.store.setTemporalDeadlineStatus(
            deadline.deadlineId,
            'cancelled',
          );
          outcomes.push({
            deadlineId: deadline.deadlineId,
            status: 'cancelled_terminal_match',
          });
          continue;
        }

        const result = await this.compositeEventConsumer.ingestCorrelatable({
          traceId: `timer:${deadline.deadlineId}`,
          sourceEventId: `timer:${deadline.deadlineId}`,
          name: 'event-intelligence.timer.reached',
          serverId: 'event-intelligence:timer',
          provider: 'event-intelligence',
          occurredAt: now.toISOString(),
          data: {
            deadlineId: deadline.deadlineId,
            triggerId: deadline.triggerId,
            triggerVersion: deadline.triggerVersion,
            matchId: deadline.matchId,
            conditionId: deadline.conditionId,
            dueAt: deadline.dueAt,
          },
        });

        if (result.results.length > 0) {
          await this.store.setTemporalDeadlineStatus(
            deadline.deadlineId,
            'fired',
          );
          outcomes.push({
            deadlineId: deadline.deadlineId,
            status: 'fired',
            results: result.results,
            deliveries: result.deliveries,
          });
        } else {
          outcomes.push({
            deadlineId: deadline.deadlineId,
            status: 'deferred',
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
        console.error(JSON.stringify({
          message: 'temporal_deadline_scheduler_error',
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
