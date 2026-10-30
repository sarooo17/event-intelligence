// This is an independent test host: no EI imports, policy or agent SDK.
 // In-memory host state exercises authority semantics, NOT durable HA receipts.
import { createHash, randomUUID } from 'node:crypto';
const key = (...ids) => JSON.stringify(ids);
const scopeKey = (org, workspace) => 'lab-' + createHash('sha256')
  .update(key(org, workspace)).digest('hex').slice(0, 24);
const denied = () => Object.assign(new Error('Host authority revoked or invalid'), {
  code: 'LAB_HOST_DENIED',
});

export function makeRuntimeHost() {
  const members = new Map(), agents = new Map(), tickets = new WeakMap();
  const tools = new Map(), outbox = new Map(), shutdownHooks = [];

  const membershipKey = (org, workspace, team, user) => key(org, workspace, team, user);
  function authorize(ticket) {
    const claimed = tickets.get(ticket);
    if (!claimed) throw denied(); // Forged model/event identity is never an authority.
    const { org, workspace, team, user, agentId } = claimed;
    const record = agents.get(agentId);
    if (!members.get(membershipKey(org, workspace, team, user)) ||
        !record?.active || record.org !== org ||
        record.workspace !== workspace || record.team !== team) throw denied();
    return { ...claimed, record };
  }
  function ownerActive(record) {
    return record?.active &&
      members.get(membershipKey(record.org, record.workspace, record.team, record.owner));
  }

  return Object.freeze({
    addMember({ org, workspace, team, user }) {
      members.set(membershipKey(org, workspace, team, user), true);
    },
    revokeMember({ org, workspace, team, user }) {
      members.set(membershipKey(org, workspace, team, user), false);
    },
    addAgent({ id, org, workspace, team, owner, kind = 'agent' }) {
      if (!['agent', 'graph', 'job'].includes(kind) || agents.has(id)) throw denied();
      agents.set(id, { id, org, workspace, team, owner, kind, active: true });
    },
    revokeAgent(id) {
      const value = agents.get(id);
      if (value) value.active = false;
    },
    issueTicket({ org, workspace, team, user, agentId }) {
      const ticket = Object.freeze({});
      tickets.set(ticket, { org, workspace, team, user, agentId });
      try { authorize(ticket); } catch (error) { tickets.delete(ticket); throw error; }
      return ticket;
    },
    resolveContext(ticket) {
      const { org, workspace, user, record } = authorize(ticket);
      return {
        scopeId: scopeKey(org, workspace),
        target: { runtime: 'portable-lab', kind: record.kind, id: record.id },
        actor: { type: 'agent', principal_id: record.id, tenant_id: org },
        owner: { type: 'user', principal_id: user, tenant_id: org },
      };
    },
    control({ runtimeContext, action }) {
      const { org, user, record } = authorize(runtimeContext);
      if (record.owner !== user) {
        return { action: 'return', result: {
          ok: false, error: { code: 'LAB_OWNER_REQUIRED', message: 'Owner approval required' },
        } };
      }
      // Test-host owner approval happens above. Issue a fresh host-only
      // confirmation for THIS authorized mutation; never accept it from
      // model arguments, external event data, or reuse an actor/action token.
      // Production hosts must persist/link approval to the request and policy.
      return { action: 'execute', execution: {
        confirmationId: randomUUID(),
      } };
    },
    registerNative(native, capability) {
      if (tools.has(native.name)) throw Error('LAB_DUPLICATE_TOOL');
      tools.set(native.name, { native, capability });
    },
    names: () => [...tools.keys()],
    capabilities: () => [...tools.values()].map(row => row.capability),
    invoke(name, args, ticket) {
      // The existing host checks authority on EVERY native call, not only at registration.
      authorize(ticket);
      const tool = tools.get(name);
      if (!tool) throw Object.assign(Error('LAB_TOOL_NOT_EXPOSED'), { code: 'LAB_TOOL_NOT_EXPOSED' });
      return tool.native.invoke(args, ticket);
    },
    onClose(hook) { shutdownHooks.push(hook); },
    async close() {
      for (const close of shutdownHooks.splice(0).reverse()) await close();
      tools.clear();
    },
    receiptNamespace: 'portable-lab:single-process',
    hasReceipt(receiptId, activation) {
      const current = outbox.get(receiptId);
      if (current === undefined) return false;
      const target = activation?.target;
      const record = agents.get(target?.id);
      if (target?.runtime !== 'portable-lab' || !record ||
          record.kind !== target.kind ||
          current !== key(record.org, record.workspace, record.id, activation?.wake?.wakeId)) {
        throw Object.assign(new Error('LAB_RECEIPT_COLLISION'), {
          code: 'LAB_RECEIPT_COLLISION',
        });
      }
      return true;
    },
    receiptCount() { return outbox.size; },
    resolveWakeTarget(target) {
      if (target?.runtime !== 'portable-lab') return null;
      const record = agents.get(target.id);
      return record && record.kind === target.kind && ownerActive(record)
        ? Object.freeze({ ...record }) : null;
    },
    deliverWake({ activation, target, receiptId }) {
      const record = agents.get(activation.target?.id);
      if (!record || !ownerActive(record) || !target ||
          record.id !== target.id || record.kind !== activation.target.kind ||
          record.org !== target.org || record.workspace !== target.workspace ||
          record.team !== target.team || record.owner !== target.owner) throw denied();
      const signature = key(record.org, record.workspace, record.id, activation.wake.wakeId);
      const previous = outbox.get(receiptId);
      if (previous && previous !== signature) throw Error('LAB_RECEIPT_COLLISION');
      if (!previous) outbox.set(receiptId, signature);
      // In-memory only: no claim that this is an atomic cross-worker transaction.
      return { runtimeReceiptId: receiptId, duplicate: Boolean(previous) };
    },
  });
}
