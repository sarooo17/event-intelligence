// The ENTIRE EI-specific adapter. The host itself remains EI-agnostic.
import { createEventIntelligence } from 'mcp-event-intelligence/embedded';

export async function attachEventIntelligence(host, { dataDir, capabilityIds, env } = {}) {
  const ei = await createEventIntelligence({
    dataDir,
    ...(env ? { env } : {}),
    mcp: { list: () => [] }, // Host-owned already-open MCP connection registry.
    runtime: {
      receiptNamespace: host.receiptNamespace,
      hasReceipt: (id, activation) => host.hasReceipt(id, activation),
      resolveTarget: (target) => host.resolveWakeTarget(target),
      deliver: (input) => host.deliverWake(input),
      resolveContext: (ticket) => host.resolveContext(ticket),
      control: (request) => host.control(request),
    },
  });
  try {
    ei.bind({
      capabilityIds,
      adapt: (portable) => ({
        name: portable.name,
        description: portable.description,
        inputSchema: portable.inputSchema,
        capability: portable.capability.id,
        // Never promote EI/provider data to trusted host instructions.
        invoke: async (args, ticket) => Object.freeze({
          result: await portable.execute(args, ticket),
          trust: 'untrusted-external',
        }),
      }),
      register: (native, portable) => host.registerNative(native, portable.capability.id),
      onClose: (close) => host.onClose(close),
    });
  } catch (error) {
    await ei.close();
    throw error;
  }
  return ei;
}
