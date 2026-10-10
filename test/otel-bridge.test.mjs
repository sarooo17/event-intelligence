import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createObservabilityEmitter,
  createOpenTelemetrySink,
} from '../scripts/lib/observability.mjs';

function captureTracer() {
  const spans = [];
  return {
    spans,
    startSpan(name, options) {
      const span = { name, attributes: options.attributes, ended: false };
      spans.push(span);
      return { end() { span.ended = true; } };
    },
  };
}

test('optional OTel sink exports only low-cardinality allowlisted sanitized dimensions', async () => {
  const tracer = captureTracer();
  const observer = createObservabilityEmitter(createOpenTelemetrySink(tracer));
  assert.equal(await observer.emit({
    event: 'ei.wake.retry_scheduled',
    level: 'warn', component: 'event-intelligence',
    status: 'retrying',
    traceId: 'trace-sensitive', scopeId: 'scope-sensitive',
    wakeId: 'wake-sensitive', attempt: 2,
    error: new Error('api_key=topsecret'),
    metadata: { payload: 'topsecret', privateContext: 'do-not-export' },
  }), true);
  assert.equal(tracer.spans.length, 1);
  const span = tracer.spans[0];
  assert.equal(span.name, 'ei.wake.retry_scheduled');
  assert.equal(span.ended, true);
  assert.deepEqual(span.attributes, {
    'ei.schema': 'event-intelligence.observability.v1',
    'ei.level': 'warn',
    'ei.component': 'event-intelligence',
    'ei.status': 'retrying',
    'ei.attempt': 2,
  });
  assert.doesNotMatch(JSON.stringify(span), /topsecret|trace-sensitive|wake-sensitive|scope-sensitive|privateContext/);
});

test('correlations require explicit opt-in; direct bridge calls remain redacted', async () => {
  const tracer = captureTracer();
  const sink = createOpenTelemetrySink(tracer, { includeCorrelations: true });
  sink.emit({
    event: 'ei.source.error',
    schema: 'event-intelligence.observability.v1',
    component: 'event-intelligence',
    level: 'error',
    status: 'Bearer secret-token',
    traceId: 'Bearer secret-token',
    scopeId: 'scope-1',
    metadata: { credential: 'secret-token', instruction: 'not an attribute' },
  });
  assert.equal(tracer.spans[0].attributes['ei.scopeId'], 'scope-1');
  assert.match(tracer.spans[0].attributes['ei.traceId'], /redacted/);
  assert.doesNotMatch(JSON.stringify(tracer.spans), /secret-token|instruction/);
});

test('broken OTel SDK and disabled namespace cannot alter EI caller behavior', async () => {
  assert.throws(() => createOpenTelemetrySink({}), /startSpan/);
  assert.throws(() => createOpenTelemetrySink(captureTracer(), { includeCorrelations: 'yes' }), /boolean/);
  const tracer = { startSpan() { throw new Error('collector failed'); } };
  const observer = createObservabilityEmitter(createOpenTelemetrySink(tracer));
  assert.equal(await observer.emit({ event: 'ei.lifecycle.started' }), true);
  assert.doesNotThrow(() => createOpenTelemetrySink(captureTracer()).emit({ event: 'external.event' }));
});
