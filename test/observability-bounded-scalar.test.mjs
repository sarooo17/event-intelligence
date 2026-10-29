import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createObservabilityEmitter as createDiagnosticEmitter,
  serializeObservabilityError,
  MAX_OBSERVABILITY_INPUT_CHARS,
} from '../scripts/lib/observability.mjs';

const createObservabilityEmitter=(sink,options={})=>
  createDiagnosticEmitter(sink,{...options,privacyLevel:'diagnostic'});


test('oversized decoded telemetry dimensions never undergo credential text projection',async()=>{
  const records=[];
  const emit=createObservabilityEmitter(record=>records.push(record),{
    now:()=>new Date('2026-10-18T00:00:00Z'),
  });
  const oversized='x'.repeat(MAX_OBSERVABILITY_INPUT_CHARS)+'Bearer HOST_PRIVATE_CREDENTIAL';
  await emit.emit({
    event:'ei.test.oversized',
    status:oversized,
    traceId:oversized,
    metadata:{description:oversized, nested:{reason:oversized}},
    error:new Error(oversized),
  });
  assert.equal(records[0].status,'[oversized value]');
  assert.equal(records[0].traceId,'[oversized value]');
  assert.equal(records[0].metadata.description,'[oversized value]');
  assert.equal(records[0].metadata.nested.reason,'[oversized value]');
  assert.equal(records[0].error.message,'[oversized value]');
  assert.equal(JSON.stringify(records).includes('HOST_PRIVATE_CREDENTIAL'),false);
});

test('normal credential strings and allowed maximum-length scalar still redact',async()=>{
  const output=serializeObservabilityError(new Error(
    'token=private-credential Bearer another-private-credential'));
  assert.equal(output.message,'token=[redacted] Bearer [redacted]');
  const records=[];
  const emitter=createObservabilityEmitter(record=>records.push(record));
  await emitter.emit({
    event:'ei.test.boundary',
    metadata:{
      a:'y'.repeat(MAX_OBSERVABILITY_INPUT_CHARS),
      b:'z'.repeat(MAX_OBSERVABILITY_INPUT_CHARS+1),
      c:'Bearer secret-not-allowed',
    },
  });
  assert.ok(records[0].metadata.a.startsWith('y'));
  assert.ok(records[0].metadata.a.length<=1001);
  assert.equal(records[0].metadata.b,'[oversized value]');
  assert.equal(records[0].metadata.c,'Bearer [redacted]');
});

test('async host sink failure remains isolated despite oversized source fields',async()=>{
  const emitter=createObservabilityEmitter(async()=>{throw Error('sink failed')});
  assert.equal(await emitter.emit({
    event:'ei.test.sink',
    eventName:'M'.repeat(MAX_OBSERVABILITY_INPUT_CHARS+1),
  }),true);
});


test('raw control fields are bounded before trim/lowercase/number parsing',async()=>{
  const oversized=' '.repeat(MAX_OBSERVABILITY_INPUT_CHARS+1);
  const events=[];
  const emit=createObservabilityEmitter(row=>events.push(row));
  await assert.rejects(emit.emit({
    event:'ei.good.event'+oversized,
    attempt:1,
  }),/input size limit/);
  await assert.rejects(emit.emit({
    event:'ei.good.event',
    level:'INFO'+oversized,
  }),/unsupported observability level/);
  assert.equal(events.length,0,'invalid giant control strings cannot reach sink');
  assert.equal(await emit.emit({
    event:'ei.test.attempt-oversize',
    level:'INFO',
    attempt:oversized+'100000',
  }),true);
  assert.equal(events[0].attempt,undefined,
    'huge numeric-looking attempts must not be trimmed/parsed');
  assert.equal(events[0].level,'info');
  assert.equal(await emit.emit({
    event:'ei.test.valid',
    level:'WARN',
    attempt:'  9  ',
  }),true);
  assert.equal(events[1].attempt,9);
  assert.equal(events[1].level,'warn');
});
