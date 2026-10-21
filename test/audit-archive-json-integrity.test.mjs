import assert from 'node:assert/strict';
import test from 'node:test';
import {parseUnambiguousAuditArchiveJson} from '../scripts/lib/audit-archive-json-integrity.mjs';

test('signed audit JSON scanner rejects ambiguous duplicate member names at every depth',()=>{
  const good=[
    '{"scopeId":"one","records":[{"details":{"a":1,"b":2}},{"details":{"a":3}}]}',
    '{"scopeId":"one","nested":{"scopeId":"two"},"array":[{},{"safe":true}]}',
    '{"name":"\\u0078","values":["scopeId","scopeId"],"other":null}',
    '{"msg":"replacement-�","quoted":"\\\"scopeId\\\""}',
  ];
  for(const value of good){
    assert.deepEqual(parseUnambiguousAuditArchiveJson(Buffer.from(value)).parsed,
      JSON.parse(value));
  }
  for(const value of [
    '{"scopeId":"attacker","scopeId":"trusted"}',
    '{"scopeId":"attacker","sc\\u006fpeId":"trusted"}',
    '{"pages":[{"records":[{"details":{"x":1,"x":2}}]}]}',
    '{"pages":[{"records":[{"details":1,"details":2}]}]}',
    '{"pages":[{"records":[],"record\\u0073":[]}]}',
    '{"a":1,"a":2}', '{"a":1,"a":2,"b":3}',
    '{"x":1,"x":2.0}', '{"x":{"foo":1,"foo":2}}',
    '{"a":1,}', '{"a":[1,]}', '{"a":1} garbage',
  ]){
    assert.throws(()=>parseUnambiguousAuditArchiveJson(Buffer.from(value)),
      {name:'SyntaxError'},value);
  }
});
test('rejects invalid UTF-8, malformed control/escape and overdeep archive nesting',()=>{
  for(const bytes of [
    Buffer.from([0x7b,0x22,0x78,0x22,0x3a,0x22,0xff,0x22,0x7d]),
    Buffer.from([0x7b,0x22,0x78,0x22,0x3a,0x22,0xc0,0xaf,0x22,0x7d]),
    Buffer.from('{"x":"\n"}'),
    Buffer.from('{"x":"\\uZZZZ"}'),
    Buffer.from('['.repeat(80)+'0'+']'.repeat(80)),
  ]){
    assert.throws(()=>parseUnambiguousAuditArchiveJson(bytes));
  }
});
