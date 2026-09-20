import { createHmac } from 'node:crypto';
import { canonicalWakeJson } from './wake-signature.mjs';

export function buildGenericRuntimeWakePacket({ wakeId, match, definition }) {
  if (!definition.target) {
    throw new Error('Composite trigger has no runtime target');
  }
  return {
    version: '1.0.0',
    wake_id: wakeId,
    trigger_match_id: match.matchId,
    trigger_id: match.triggerId,
    trigger_version: match.triggerVersion,
    correlation_id: match.sourceEvents[0]?.traceId ?? match.matchId,
    target: definition.target,
    source_event_refs: match.sourceEvents.slice(-50).map((event) => ({
      server_id: event.serverId ?? event.provider ?? 'event-intelligence',
      event_id: event.sourceEventId,
      event_name: event.eventName,
      trace_id: event.traceId,
    })),
    matched_at: match.updatedAt,
  };
}

export function createSignedRuntimeWakeDeliverer({ url, secret, fetchFn = fetch, now = () => Date.now() }) {
  if (!url || !secret) return null;
  return async (packet) => {
    const timestamp = String(now());
    const signature = createHmac('sha256', secret)
      .update(`${timestamp}.${canonicalWakeJson(packet)}`)
      .digest('hex');
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Event-Wake-Timestamp': timestamp,
        'X-Event-Wake-Signature': `v1=${signature}`,
      },
      body: JSON.stringify(packet),
    });
    if (!response.ok) throw new Error(`Runtime wake callback failed: HTTP_${response.status}`);
    const receipt = await response.json();
    if (typeof receipt.runtimeReceiptId !== 'string' || !receipt.runtimeReceiptId) {
      throw new Error('Runtime wake callback did not return runtimeReceiptId');
    }
    return {
      runtimeReceiptId: receipt.runtimeReceiptId,
      duplicate: receipt.duplicate === true,
      status: receipt.status ?? 'completed',
    };
  };
}

export function readRuntimeWakeTargets(raw) {
  if (!raw) return new Map();
  const parsed = JSON.parse(raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('RUNTIME_WAKE_TARGETS_JSON must be an object');
  }
  const targets = new Map();
  for (const [runtime, value] of Object.entries(parsed)) {
    if (!runtime || !value || typeof value !== 'object') {
      throw new Error('Invalid runtime wake target');
    }
    const url = new URL(value.url);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      throw new Error('Runtime wake target must use HTTPS or local HTTP');
    }
    if (typeof value.secret !== 'string' || value.secret.length < 32) {
      throw new Error('Runtime wake target secret must have at least 32 characters');
    }
    targets.set(runtime, { url: url.toString(), secret: value.secret });
  }
  return targets;
}
