import type {
  EventIntelligenceObservabilityEvent,
} from './lib/observability.d.mts';

export interface HostConformanceTriggerInput {
  triggerId: string;
  threshold: number;
  oneShot: boolean;
  maxFirings?: number;
}

export interface HostConformanceEventInput {
  eventId: string;
  value: number;
  secretProbe?: string;
}

export interface HostConformanceDelivery {
  triggerId: string;
  wakeId?: string;
  runtimeReceiptId?: string;
  [key: string]: unknown;
}

export interface HostConformanceHarness {
  createTrigger(input: HostConformanceTriggerInput): Promise<void>;
  emitEvent(input: HostConformanceEventInput): Promise<void>;
  deliveries(): Promise<readonly HostConformanceDelivery[]> | readonly HostConformanceDelivery[];
  restart(): Promise<void>;
  inspectTrigger(triggerId: string): Promise<{
    status?: string;
    fireCount?: number;
    [key: string]: unknown;
  } | null>;
  close(): Promise<void>;
}

export interface HostConformanceAdapter {
  name?: string;
  createHarness(input: {
    observability(event: EventIntelligenceObservabilityEvent): void;
  }): Promise<HostConformanceHarness> | HostConformanceHarness;
}

export interface HostConformanceResult {
  id: string;
  status: 'pass' | 'fail';
  durationMs: number;
  detail?: unknown;
  error?: string;
}

export interface HostConformanceReport {
  schema: 'event-intelligence.host-conformance.v1' | string;
  adapter: string;
  passed: boolean;
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
  results: readonly HostConformanceResult[];
  observability: {
    captured: number;
    eventNames: readonly string[];
  };
}

export const HOST_CONFORMANCE_REPORT_SCHEMA:
  'event-intelligence.host-conformance.v1';

export function runHostConformance(
  adapter: HostConformanceAdapter,
  options?: { throwOnFailure?: boolean },
): Promise<HostConformanceReport>;
