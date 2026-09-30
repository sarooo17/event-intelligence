export const EVENT_INTELLIGENCE_PROTOCOL = 'mcp-event-intelligence' as const;
export const EVENT_INTELLIGENCE_PROTOCOL_VERSION = '0.2.0' as const;
export const EVENT_INTELLIGENCE_SCHEMA_VERSION = 'ei.v0.2' as const;

export const EVENT_INTELLIGENCE_COMPATIBILITY = {
  mcpEvents: 'experimental-ext-triggers-events/design-sketch',
  mcpCore: '2026-07-28',
} as const;
