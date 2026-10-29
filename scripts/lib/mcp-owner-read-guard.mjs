import {isProxy} from 'node:util/types';

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

  // Defense in depth: never trust a malformed/buggy listTriggers adapter
  // merely because it accepted {owner}. Recheck persisted owner/tenant on
  // every returned row before an ID or version is considered authorized.
  // A custom adapter may return Proxy/getter-backed records. Authorization
  // MUST NOT execute their properties or turn their thrown secrets into
  // operator-visible errors. Only own data slots can grant visibility.
  const ownValue=(value,key)=>{
    if(!value || typeof value!=='object' || isProxy(value))return undefined;
    const slot=Object.getOwnPropertyDescriptor(value,key);
    return slot && Object.hasOwn(slot,'value') ? slot.value : undefined;
  };
  const sameOwner=(a,b)=>{
    if(!a || typeof a!=='object' || isProxy(a))return false;
    // Absent tenant is allowed for tenantless local hosts, but a getter
    // MUST NOT be interpreted as absence or a foreign tenant can slip in.
    const tenant=Object.getOwnPropertyDescriptor(a,'tenant_id');
    if(tenant && !Object.hasOwn(tenant,'value'))return false;
    return ownValue(a,'type')===b.type &&
      ownValue(a,'principal_id')===b.principal_id &&
      (tenant ? tenant.value : null)===(b.tenant_id??null);
  };

  async function assertTrigger(triggerId, version) {
    const rows = await triggerControl.listTriggers({ owner });
    if(!Array.isArray(rows) || isProxy(rows))throw notFound();
    const candidates=[];
    for(let i=0;i<rows.length;i++){
      const row=ownValue(rows,String(i));
      const definition=ownValue(row,'definition');
      const id=ownValue(definition,'triggerId');
      const rowVersion=ownValue(definition,'version');
      // Always check requested ID/version BEFORE examining any foreign
      // owner fields. An unrelated malicious row cannot leak through
      // an accessor when the request was for another owned version.
      if(id!==triggerId || typeof rowVersion!=='string' ||
          (version!==undefined && rowVersion!==version))continue;
      const state=ownValue(row,'state');
      if(!sameOwner(ownValue(state,'owner'),owner))continue;
      candidates.push({row,version:rowVersion});
    }
    const owned=candidates.sort((left,right)=>
      right.version.localeCompare(left.version,undefined,{numeric:true})
    )[0]?.row;
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

    // Without a durable wake-delivery version there is no safe way to
    // authorize matched evidence before reading it: an owner could retain
    // trigger v2 after losing v1, while this wake belongs to v1. Fail
    // CLOSED rather than selecting the latest owned trigger version.
    if (typeof delivery?.triggerVersion !== 'string' ||
        !delivery.triggerVersion ||
        delivery.matchId !== wake.sourceEventId ||
        (delivery.triggerId && delivery.triggerId !== triggerId)) {
      throw notFound();
    }
    // Pin exactly the version that produced this wake.
    const initiallyOwned = await assertTrigger(triggerId, delivery.triggerVersion);
    let match;
    try {
      // Any matched-evidence read failure may carry sensitive SQL/provider
      // diagnostics. On errors ONLY, recheck the pinned owner before allowing
      // those diagnostics to propagate.
      const matches = await store.listTriggerMatches(triggerId);
      match = matches.find((entry) =>
        entry?.matchId === wake.sourceEventId &&
        entry.triggerId === triggerId &&
        entry.triggerVersion === delivery.triggerVersion
      );
    } catch (error) {
      await assertTrigger(
        initiallyOwned.definition.triggerId,
        initiallyOwned.definition.version,
      );
      throw error;
    }
    // A missing match is already a safely redacted denial; do not perform
    // another authorization read that could replace not-found with backend
    // diagnostics or disclose owner existence.
    if (!match) throw notFound();
    // Authorization denials from THIS last lookup must not be captured by
    // the evidence-error handler: its extra query could overwrite an
    // established safe not-found with an internal storage exception.
    await assertTrigger(triggerId, match.triggerVersion);
    return match;
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
