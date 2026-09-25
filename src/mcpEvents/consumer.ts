import type { EventOccurrence } from '../protocol/types.js';
import { sha256Hex } from '../intelligenceProtocol/canonical.js';
import {
  CorrelatableEventSchema,
  type CorrelatableEvent,
} from '../intelligenceProtocol/triggerSchemas.js';

export async function mcpOccurrenceToCorrelatableEvent(
  event: EventOccurrence,
  input: {
    traceId: string;
    provider?: string;
    serverId?: string;
    subscriptionArguments?: Record<string, unknown>;
  },
): Promise<CorrelatableEvent> {
  return CorrelatableEventSchema.parse({
    traceId: input.traceId,
    sourceEventId: event.eventId,
    name: event.name,
    occurredAt: event.timestamp,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.serverId ? { serverId: input.serverId } : {}),
    subscriptionArguments: input.subscriptionArguments ?? {},
    payloadHash: await sha256Hex(event.data),
    data: event.data,
  });
}
