/**
 * Owner-scoped read guard for the standalone stdio MCP surface.
 *
 * The local MCP server has exactly one host-configured owner per process.
 * Owner identity comes from trusted server configuration, never model args.
 * Deliberately return the same not-found response for missing and foreign IDs.
 */
export function createOwnerReadGuard({ triggerControl, store, owner }) {
  if (typeof triggerControl?.listTriggers !== 'function' ||
      typeof store?.latestWake !== 'function' ||
      typeof store?.listTriggerMatches !== 'function' ||
      typeof owner?.type !== 'string' ||
      typeof owner?.principal_id !== 'string') {
    throw new TypeError('MCP owner read guard requires scoped store and configured owner');
  }

  const notFound = () => {
    const error = new Error('Resource not found for configured owner');
    error.code = 'EVENT_INTELLIGENCE_RESOURCE_NOT_FOUND';
    return error;
  };

  async function assertTrigger(triggerId, version) {
    const rows = await triggerControl.listTriggers({ owner });
    const owned = rows
      .filter((row) =>
        row?.definition?.triggerId === triggerId &&
        (version === undefined || row.definition.version === version)
      )
      .sort((left, right) =>
        String(right.definition.version).localeCompare(
          String(left.definition.version), undefined, { numeric: true },
        )
      )[0];
    if (!owned) throw notFound();
    return owned;
  }

  async function assertWake(wakeId) {
    const wake = await store.latestWake(wakeId);
    // A wake must be a trigger-produced wake, not an arbitrary event.
    const subscription = wake?.subscriptionId;
    if (typeof subscription !== 'string' ||
        !subscription.startsWith('trigger:') ||
        subscription.length <= 'trigger:'.length ||
        typeof wake.sourceEventId !== 'string') {
      throw notFound();
    }
    const triggerId = subscription.slice('trigger:'.length);
    const delivery = typeof store.getWakeDelivery === 'function'
      ? await store.getWakeDelivery(wakeId)
      : null;

    // Check ownership before looking up matched-event evidence.
    await assertTrigger(triggerId, delivery?.triggerVersion || undefined);

    // All wake/delivery/match references must agree, even if a colliding
    // match ID or corrupted subscription points to another trigger.
    if (delivery && (
      delivery.matchId !== wake.sourceEventId ||
      (delivery.triggerId && delivery.triggerId !== triggerId)
    )) {
      throw notFound();
    }
    const matches = await store.listTriggerMatches(triggerId);
    const match = matches.find((entry) =>
      entry?.matchId === wake.sourceEventId &&
      entry.triggerId === triggerId &&
      (!delivery?.triggerVersion ||
        entry.triggerVersion === delivery.triggerVersion)
    );
    if (!match) throw notFound();
    await assertTrigger(triggerId, match.triggerVersion);
    return match;
  }

  return Object.freeze({ assertTrigger, assertWake });
}
