import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAuditJsonNumberPrecision } from '../scripts/lib/audit-precision-safety.mjs';

test('raw audit JSON numeric precision policy rejects unrepresentable and rounded tokens',()=>{
  const valid=[
    '{"sequence":1,"details":{"cost":0.1,"zero":0,"safe":9007199254740991}}',
    '{"counter":2,"nested":["2.0000000000000001","9007199254740993"]}',
    '{"details":{"tiny":1e-100,"small":0.0000000000000000001}}',
    '{"x":-9007199254740991,"y":123.456789012345}',
    '{"x":0.0000,"y":1000000000.00000000}',
    '{"x":0.00000000000000000010000000000000001}',
  ];
  for(const raw of valid){
    assert.doesNotThrow(()=>assertAuditJsonNumberPrecision(raw),raw);
    assert.doesNotThrow(()=>JSON.parse(raw));
  }
  const unsafe=[
    '{"counter":9007199254740992}',
    '{"counter":9007199254740993}',
    '{"counter":2.0000000000000001}',
    '{"counter":0.10000000000000001}',
    '{"counter":1e999}',
    '{"counter":1e-999}',
    '{"counter":1.0000000000000001e-10}',
    '{"counter":-9007199254740993}',
    '{"counter":2.00000000000000001}',
    '{"counter":3e-324}',
    '{"counter":4e-324}',
    '{"counter":1.1e-323}',
    '{"counter":2.1e-323}',
    '{"counter":3.1e-323}',
    '{"counter":4.9e-324}',
    '{"counter":0.000000000000000000100000000000000001}',
    '{"counter":-3e-324}',
  ];
  for(const raw of unsafe){
    assert.throws(()=>assertAuditJsonNumberPrecision(raw),
      e=>e?.code==='EVENT_INTELLIGENCE_AUDIT_PRECISION_UNSAFE',raw);
  }
  // The canonical JS AuditChain would miss these decimal modifications.
  assert.equal(JSON.parse('{"v":2}').v,
    JSON.parse('{"v":2.0000000000000001}').v);
  assert.equal(JSON.parse('{"v":9007199254740992}').v,
    JSON.parse('{"v":9007199254740993}').v);
  assert.equal(JSON.parse('{"v":3e-324}').v,
    JSON.parse('{"v":4e-324}').v);
  assert.equal(JSON.parse('{"v":1.1e-323}').v,
    JSON.parse('{"v":1e-323}').v);
  // Equivalent exact decimal spellings remain valid; unsafe distinct
  // values rounding into the same float are rejected instead.
  assert.doesNotThrow(()=>assertAuditJsonNumberPrecision(
    '{"x":300e-2,"y":3.000,"z":3,"small":5e-324}'));

});
