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

export interface HostConformanceTriggerSummary {
  triggerId: string;
  version?: string;
  status?: string;
  fireCount?: number;
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
    version?: string;
    [key: string]: unknown;
  } | null>;
  listTriggers?(): Promise<readonly HostConformanceTriggerSummary[]> | readonly HostConformanceTriggerSummary[];
  pauseTrigger?(triggerId: string): Promise<void>;
  resumeTrigger?(triggerId: string): Promise<void>;
  updateTrigger?(input: {
    triggerId: string;
    threshold: number;
  }): Promise<void>;
  deleteTrigger?(triggerId: string): Promise<void>;
  close(): Promise<void>;
}

export interface HostConformanceAdapter {
  name?: string;
  createHarness(input: {
    observability(event: EventIntelligenceObservabilityEvent): void;
    profile: 'core' | 'management';
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
  schema: 'event-intelligence.host-conformance.v2' | string;
  profile: 'core' | 'management';
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
  'event-intelligence.host-conformance.v2';

export function runHostConformance(
  adapter: HostConformanceAdapter,
  options?: {
    throwOnFailure?: boolean;
    profile?: 'core' | 'management';
  },
): Promise<HostConformanceReport>;
