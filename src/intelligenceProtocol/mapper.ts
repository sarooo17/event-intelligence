import type { EventOccurrence } from '../protocol/types.js';
import { sha256Hex } from './canonical.js';
import {
  EventLineageSchema,
  type EventLineage,
  type RuntimeTarget,
} from './schemas.js';
import {
  EVENT_INTELLIGENCE_PROTOCOL,
  EVENT_INTELLIGENCE_PROTOCOL_VERSION,
  EVENT_INTELLIGENCE_SCHEMA_VERSION,
} from './version.js';

export interface MapMcpEventInput {
  event: EventOccurrence;
  traceId: string;
  environmentId: string;
  subscriptionId: string;
  serverId: string;
  transport: 'stdio' | 'streamable_http' | 'webhook' | 'poll' | 'internal';
  provider?: string;
  target: RuntimeTarget;
  observedAt: string;
}

export async function mapMcpEventToLineage(
  input: MapMcpEventInput,
): Promise<EventLineage> {
  const payloadHash = await sha256Hex(input.event.data);

  return EventLineageSchema.parse({
    protocol: EVENT_INTELLIGENCE_PROTOCOL,
    protocolVersion: EVENT_INTELLIGENCE_PROTOCOL_VERSION,
    schemaVersion: EVENT_INTELLIGENCE_SCHEMA_VERSION,
    traceId: input.traceId,
    environmentId: input.environmentId,
    subscriptionId: input.subscriptionId,
    sourceEventId: input.event.eventId,
    observedAt: input.observedAt,
    source: {
      serverId: input.serverId,
      transport: input.transport,
      ...(input.provider ? { provider: input.provider } : {}),
      cursor: input.event.cursor ?? null,
    },
    target: input.target,
    event: {
      name: input.event.name,
      occurredAt: input.event.timestamp,
      payloadHash,
    },
  });
}
