export type DoctorStatus = 'pass' | 'warn' | 'fail';
export interface DoctorCheck {
  readonly id: string;
  readonly status: DoctorStatus;
  readonly message: string;
}
export interface DoctorReport {
  readonly schema: 'event-intelligence.integration-doctor.v1';
  readonly mode: 'embedded-contract' | 'offline-environment';
  readonly status: DoctorStatus;
  readonly totals: Readonly<Record<DoctorStatus, number>>;
  readonly checks: readonly DoctorCheck[];
}

export interface EmbeddedDoctorInput {
  mcp?: {
    list?: () => unknown;
    subscribe?: (listener: () => void) => unknown;
  };
  runtime?: {
    deliver?: (...args: any[]) => unknown;
    resolveContext?: (...args: any[]) => unknown;
    control?: (...args: any[]) => unknown;
    receiptId?: (...args: any[]) => unknown;
    receiptNamespace?: string;
    hasReceipt?: (...args: any[]) => unknown;
    resolveTarget?: (...args: any[]) => unknown;
    projectResult?: (...args: any[]) => unknown;
    projectError?: (...args: any[]) => unknown;
  };
  storeCapabilities?: {
    sharedState?: string;
    scopeIsolation?: string;
    wakeClaims?: string;
    partitionLeases?: string;
  };
  requireSharedStore?: boolean;
}

export function diagnoseEmbeddedConfiguration(
  options?: EmbeddedDoctorInput,
): DoctorReport;

export function diagnoseEnvironment(options?: {
  nodeVersion?: string;
  env?: Record<string, string | undefined>;
}): DoctorReport;

export function formatDoctorReport(report: DoctorReport): string;
