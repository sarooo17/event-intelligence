import type { EventOccurrence } from '../protocol/types.js';
import { sha256Hex } from '../intelligenceProtocol/canonical.js';
import {
  parseCorrelatableEvent,
  type CorrelatableEvent,
} from '../intelligenceProtocol/triggerSchemas.js';
import { snapshotUntrustedEventData } from '../protocol/ownPath.js';

export async function mcpOccurrenceToCorrelatableEvent(
  event: EventOccurrence,
  input: {
    traceId: string;
    provider?: string;
    serverId?: string;
    subscriptionArguments?: Record<string, unknown>;
    receivedAt?: string;
  },
): Promise<CorrelatableEvent> {
  // The occurrence may come from a third-party provider or host. Snapshot it
  // before reading eventId/name/timestamp, invoking the canonical hash, or
  // parsing any Zod record. Proxies/getters must not execute even once.
  const safeEvent = snapshotUntrustedEventData(event) as EventOccurrence;
  const safeArguments = snapshotUntrustedEventData(
    input.subscriptionArguments ?? {},
  ) as Record<string, unknown>;
  const payloadHash = await sha256Hex(safeEvent.data);
  return parseCorrelatableEvent({
    traceId: input.traceId,
    sourceEventId: safeEvent.eventId,
    name: safeEvent.name,
    occurredAt: safeEvent.timestamp,
    ...(input.receivedAt ? { receivedAt: input.receivedAt } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.serverId ? { serverId: input.serverId } : {}),
    subscriptionArguments: safeArguments,
    payloadHash,
    data: safeEvent.data,
  });
}
