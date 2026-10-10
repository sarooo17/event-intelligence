import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createObservabilityEmitter,
  serializeObservabilityError,
} from '../scripts/lib/observability.mjs';

// Deterministic adversarial telemetry corpus. No real credentials.
const secrets = Array.from({length:64},(_,index)=>
  'deadbeef' + (index * 73856093).toString(36) + 'abcXYZ' + index
);

test('credential-bearing metadata, errors and public dimensions are redacted',async()=>{
  const records=[];
  const emit=createObservabilityEmitter(event=>records.push(event),{
    now:()=>new Date('2026-10-10T12:00:00.000Z'),
  });
  for (const [i,secret] of secrets.entries()){
    await emit.emit({
      event:'ei.source.delivery_failed',
      level:'warn',
      scopeId:'tenant-' + i + ' Bearer ' + secret,
      traceId:'Bearer ' + secret,
      eventName:'update token=' + secret,
      status:'authorization: ' + secret,
      connectionId:'connection password=' + secret,
      error:Object.assign(
        new Error('failed: api_key=' + secret),
        {code:'TOKEN=' + secret},
      ),
      metadata:{
        note:'Bearer ' + secret,
        nested:{
          comment:'token=' + secret,
          deep:[{plain:'authorization=' + secret}],
          headers:{Authorization:secret,cookie:secret},
        },
        payload:{eventData:secret},
      },
    });
    const record=records.at(-1);
    const serialized=JSON.stringify(record);
    assert.doesNotMatch(serialized,new RegExp(secret),String(i));
    assert.equal(record.traceId,'Bearer [redacted]');
    assert.equal(record.metadata.note,'Bearer [redacted]');
    assert.equal(record.metadata.nested.headers?.Authorization,undefined);
    assert.equal(record.metadata.payload,undefined);
    assert.equal(Object.isFrozen(record),true);
  }
  assert.equal(records.length,64);
});

test('plain errors use working credential regex for Bearer and key=value',()=>{
  for(const secret of secrets){
    const output=serializeObservabilityError(
      new Error('Request refused: Bearer '+secret+'; secret='+secret),
    );
    assert.doesNotMatch(JSON.stringify(output),new RegExp(secret));
    assert.match(output.message,/Bearer \[redacted\]/);
    assert.match(output.message,/secret=\[redacted\]/);
  }
});

test('redaction keeps non-secret correlation IDs and sink behavior unchanged',async()=>{
  const rows=[];
  const observer=createObservabilityEmitter(record=>rows.push(record));
  assert.equal(await observer.emit({
    event:'ei.wake.delivered',
    traceId:'trace-123',scopeId:'tenant-42',wakeId:'wake-abc',
    status:'delivered', metadata:{attempts:2,reason:'ok'},
  }),true);
  assert.equal(rows[0].traceId,'trace-123');
  assert.equal(rows[0].scopeId,'tenant-42');
  assert.equal(rows[0].wakeId,'wake-abc');
  assert.deepEqual(rows[0].metadata,{attempts:2,reason:'ok'});
  const broken=createObservabilityEmitter(()=>{throw new Error('sink off');});
  assert.equal(await broken.emit({event:'ei.wake.delivered'}),false);
});

test('synthetic mutation matrix varies JSON quoting, Unicode forms, case and separators',async()=>{
  const events=[];
  const observer=createObservabilityEmitter(e=>events.push(e));
  for(let i=0;i<secrets.length;i++){
    const secret=secrets[i];
    const variants=[
      'Bearer '+secret,
      'Bearer\u0085'+secret,
      '\u017Fecret='+secret,
      JSON.stringify({token:secret}),
      "authorization='"+secret+"'",
      '\uFF21\uFF30\uFF29\uFF3F\uFF4B\uFF45\uFF59\uFF1D'+secret,
      'TOKEN:'+secret,
      'Bearer\u2028'+secret,
    ];
    const mutated=variants[i%variants.length];
    await observer.emit({
      event:'ei.source.poll_failed',
      status:mutated,
      error:new Error(mutated),
      metadata:{message:mutated,nested:{value:mutated}},
    });
    const serialized=JSON.stringify(events.at(-1));
    assert.ok(!serialized.includes(secret),
      'unredacted variant '+(i%variants.length)+' at seed '+i);
  }
  assert.equal(events.length,secrets.length);
});
