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

// The parent cannot inspect the child's full structured observability event.
// Preserve the leak detection result BEFORE projecting to safe IPC metadata:
// without it a bad host could leak the canary while still passing conformance.
function forwardObservation(event) {
  // Even malformed/unnamed observations may contain secret-bearing fields.
  // Evaluate the complete input before considering its event-name shape.
  let sensitiveEvidenceLeak = false;
  try {
    sensitiveEvidenceLeak = JSON.stringify(event)
      .includes('ei-conformance-secret-probe');
  } catch {
    // Unserializable observability is not proof of payload redaction.
    sensitiveEvidenceLeak = true;
  }
  if (typeof event?.event !== 'string' && !sensitiveEvidenceLeak) return;
  process.send?.({
    type: 'observation',
    // An observation's NAME can itself contain evidence. When any part of
    // the original event leaks, forward only the verdict and never a string
    // that could expose the canary in IPC or conformance eventNames.
    ...(!sensitiveEvidenceLeak && typeof event?.event === 'string'
      ? { event: event.event }
      : {}),
    sensitiveEvidenceLeak,
  });
}

const harness = await referenceHostAdapter.createHarness({
  dataDir,
  preserveData: true,
  observability: forwardObservation,
});

if (process.env.EI_CONFORMANCE_INJECT_OBSERVATION_LEAK === '1') {
  // Explicit negative control: run through the same in-worker sanitization
  // that handles real host observations; never forward raw probe payloads.
  forwardObservation({
    event: 'ei-conformance-secret-probe',
    metadata: { untrustedPayload: 'ei-conformance-secret-probe' },
  });
}
if (process.env.EI_CONFORMANCE_INJECT_UNNAMED_LEAK === '1') {
  // Unlike a named event, this malformed observation has no event string.
  // The full-content safety check must still fail closed.
  forwardObservation({
    metadata: { untrustedPayload: 'ei-conformance-secret-probe' },
  });
}

process.on('message', async (message) => {
  if (!Number.isSafeInteger(message?.id) || !allowed.has(message?.method)) return;
  try {
    if (process.env.EI_CONFORMANCE_HANG_METHOD === message.method) {
      // Deliberately never respond: the parent must retire a worker when its
      // finite RPC deadline expires, rather than continuing after timeout.
      await new Promise(() => {});
    }
    const result = (
      process.env.EI_CONFORMANCE_SUPPRESS_RESTORED_RECEIPT === '1' &&
      message.method === 'readWakeReceipt'
    )
      ? null // Inject missing durable receipt *inside* the restarted worker.
      : await harness[message.method](...(message.args ?? []));
    process.send?.({ type: 'reply', id: message.id, result: result ?? null });
  } catch {
    process.send?.({
      type: 'reply', id: message.id,
      error: 'Host conformance worker operation failed: ' + message.method,
    });
  }
});

process.send?.({ type: 'ready', pid: process.pid });
