// Compile-only clean consumer. Import from PACKAGE entrypoint to catch
// accidentally removed re-exports and declaration/implementation drift.
import {
  createEventIntelligence,
  negotiateHostContract,
  HOST_CONTRACT_VERSION,
  HOST_CONTRACT_CAPABILITIES,
  type HostContractV1,
  type HostContractNegotiationV1,
  type EventIntelligenceOptions,
} from 'mcp-event-intelligence/embedded';

const requirements: HostContractV1 = {
  version: '1',
  required: ['mcp.registry', 'storage.durable', 'wake.receipts', 'tooling.owner-scoped'],
};
const metadata: HostContractNegotiationV1 = negotiateHostContract(
  { version: '1', required: [] },
  { runtime: { deliver: () => ({ runtimeReceiptId: 'host-owned' }) } },
);
const version: '1' = HOST_CONTRACT_VERSION;
const ids: readonly string[] = HOST_CONTRACT_CAPABILITIES;
const options: EventIntelligenceOptions = {
  dataDir: './external-host-data',
  mcp: { list: () => [] },
  runtime: {
    deliver: () => ({ runtimeReceiptId: 'host-managed' }),
    receiptNamespace: 'consumer-check',
    hasReceipt: async id => id.length > 0,
  },
  hostContract: requirements,
};
const started = createEventIntelligence(options);
void started.then(host => {
  const result: HostContractNegotiationV1 | undefined = host.hostContract;
  if (result) {
    const v: '1' = result.version;
    const readiness: 'configuration-validated' = result.readiness;
    void v;
    void readiness;
  }
});
void metadata;
void version;
void ids;

// This must remain rejected by the public declaration.
// @ts-expect-error pre-v1 HostContract supports only version '1'
const futureContract: HostContractV1 = { version: '2', required: [] };
void futureContract;
