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

    // Bind the exact initially owned version so a failed matched-evidence
    // read cannot fall back to a different version still owned by the
    // principal after a concurrent transfer of THIS version.
    const initiallyOwned = await assertTrigger(
      triggerId, delivery?.triggerVersion || undefined,
    );
    try {
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
    } catch (error) {
      // A rejected store.listTriggerMatches() may contain sensitive SQL,
      // provider or matched-event details. Re-check the pinned owner before
      // propagating ANY error from this post-authorization evidence phase.
      // If transferred, notFound replaces the original error; if still
      // authorized, preserve the real error for operator diagnostics.
      await assertTrigger(
        initiallyOwned.definition.triggerId,
        initiallyOwned.definition.version,
      );
      throw error;
    }
  }

  /**
   * Do not return a prepared inspector result after the configured owner has
   * lost access during an asynchronous read. The final owner lookup is the
   * read's authorization snapshot: a transfer committed BEFORE it is denied.
   * A transfer committing AFTER that snapshot can still race the return;
   * this is deliberately NOT a cross-worker atomic revocation fence (#235).
   */
  async function withAuthorizedTriggerResult(triggerId, version, build) {
    if (typeof build !== 'function') throw new TypeError('authorized read callback required');
    const owned = await assertTrigger(triggerId, version);
    try {
      // Await INSIDE try so that rejection also reaches finally.
      return await build(owned);
    } finally {
      // A builder can reject with an error carrying sensitive details.
      // If owner/tenant access was revoked during that rejected read,
      // the final owner check MUST replace the builder error with the
      // same nondisclosing not-found response used for successful reads.
      await assertTrigger(owned.definition.triggerId, owned.definition.version);
    }
  }

  /**
   * The initial check protects access to evidence, the final check protects
   * the result returned to the MCP caller when ownership changes DURING
   * activation hydration. A final authorization snapshot is not a guarantee
   * that already-authorized reads can be retroactively canceled.
   */
  async function withAuthorizedWakeResult(wakeId, build) {
    if (typeof build !== 'function') throw new TypeError('authorized wake callback required');
    const match = await assertWake(wakeId);
    try {
      return await build(match);
    } finally {
      // Do not expose hydration/host errors after the last authorized
      // owner has transferred. This runs for success AND rejection.
      await assertTrigger(match.triggerId, match.triggerVersion);
    }
  }

  return Object.freeze({
    assertTrigger, assertWake,
    withAuthorizedTriggerResult, withAuthorizedWakeResult,
  });
}
