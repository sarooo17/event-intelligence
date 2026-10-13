// Locally-authored conformance fixture, not a production IPC protocol.
// This process owns a complete EI host and durable store. Its parent owns
// only external-delivery observation and requests a *new process* on restart.
import { referenceHostAdapter } from './reference-host.mjs';

const allowed = new Set([
  'createTrigger', 'emitEvent', 'deliveries', 'inspectTrigger',
  'readWakeReceipt', 'listTriggers', 'pauseTrigger', 'resumeTrigger',
  'updateTrigger', 'deleteTrigger', 'close',
]);

const dataDir = process.env.EI_CONFORMANCE_DATA_DIR;
if (!dataDir) throw new Error('EI_CONFORMANCE_DATA_DIR is required');

const harness = await referenceHostAdapter.createHarness({
  dataDir,
  preserveData: true,
  observability(event) {
    // Event names are enough for the conformance report. Never forward
    // untrusted event payloads, source credentials or raw exceptions.
    if (typeof event?.event === 'string') {
      process.send?.({ type: 'observation', event: event.event });
    }
  },
});

process.on('message', async (message) => {
  if (!Number.isSafeInteger(message?.id) || !allowed.has(message?.method)) return;
  try {
    const result = await harness[message.method](...(message.args ?? []));
    process.send?.({ type: 'reply', id: message.id, result: result ?? null });
  } catch {
    process.send?.({
      type: 'reply', id: message.id,
      error: 'Host conformance worker operation failed: ' + message.method,
    });
  }
});

process.send?.({ type: 'ready', pid: process.pid });
