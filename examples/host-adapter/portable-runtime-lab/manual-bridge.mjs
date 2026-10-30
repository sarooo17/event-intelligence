// A/B control: direct, explicit portable-tool translation with no EI binder.
// Same host, exact same published EI package; not another host/runtime API.
import { createEventIntelligence } from 'mcp-event-intelligence/embedded';

export async function attachManually(host, { dataDir, capabilityIds, env } = {}) {
  const ei = await createEventIntelligence({
    dataDir,
    ...(env ? { env } : {}),
    mcp: { list: () => [] },
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
    // Before the first native registration, reject every unknown allowlist ID
    // and prepare all descriptors. This duplicates the current EI binder's
    // fail-closed semantics rather than omitting correctness to win LOC.
    const all = ei.tools;
    const known = new Set(all.map(t => t.capability.id));
    if (capabilityIds !== undefined && (
      !Array.isArray(capabilityIds) ||
      [...capabilityIds].some(id => typeof id !== 'string' || !id.trim() || !known.has(id))
    )) throw Error('manual bridge capability allowlist invalid');
    const selected = capabilityIds === undefined
      ? all : all.filter(t => capabilityIds.includes(t.capability.id));
    const adapted = selected.map(portable => ({
      name: portable.name,
      description: portable.description,
      inputSchema: portable.inputSchema,
      capability: portable.capability.id,
      invoke: async (args, ticket) => Object.freeze({
        result: await portable.execute(args, ticket),
        trust: 'untrusted-external',
      }),
    }));
    for (let i = 0; i < adapted.length; i++) {
      host.registerNative(adapted[i], selected[i].capability.id);
    }
    host.onClose(() => ei.close());
  } catch (error) {
    await ei.close();
    throw error;
  }
  return ei;
}
