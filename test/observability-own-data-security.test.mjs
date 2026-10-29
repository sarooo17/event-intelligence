import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createObservabilityEmitter as createDiagnosticEmitter,
  serializeObservabilityError,
} from '../scripts/lib/observability.mjs';

const createObservabilityEmitter=(sink,options={})=>
  createDiagnosticEmitter(sink,{...options,privacyLevel:'diagnostic'});


test('telemetry skips nested getters and does not execute Proxy traps', async () => {
  let executed = 0;
  const forbidden = 'unlabelled-dont-leak-value';
  const top = {};
  Object.defineProperty(top, 'evil', {
    enumerable: true, get(){ executed++; return forbidden; },
  });
  const nested = { safe: 'ok', top };
  const proxy = new Proxy({ text: forbidden }, {
    ownKeys(){ executed++; throw new Error('do not inspect a proxy'); },
    get(){ executed++; throw new Error('do not read a proxy'); },
    getOwnPropertyDescriptor(){ executed++; throw new Error('no reflection'); },
    getPrototypeOf(){ executed++; throw new Error('no prototype traps'); },
  });
  const arr = ['ok'];
  Object.defineProperty(arr, '1', {
    enumerable: true, get(){ executed++; return forbidden; },
  });
  const rows=[];
  const emitter=createObservabilityEmitter(row=>rows.push(row),{
    now:()=>new Date('2026-10-18T00:00:00.000Z'),
  });
  assert.equal(await emitter.emit({
    event:'ei.source.poll_failed',
    traceId:'trace-1',
    metadata:{
      nested, unsafeProxy:proxy, array:arr,
      safe:{ count:2, note:'Bearer sampleToken' },
    },
  }),true);
  assert.equal(executed,0,'input accessors and Proxy traps must never execute');
  assert.equal(rows.length,1);
  assert.equal(rows[0].metadata.nested.top.evil,undefined);
  assert.equal(rows[0].metadata.unsafeProxy,'[untrusted value]');
  assert.deepEqual(rows[0].metadata.array,['ok','[untrusted value]']);
  assert.equal(rows[0].metadata.safe.note,'Bearer [redacted]');
  assert.doesNotMatch(JSON.stringify(rows),/unlabelled-dont-leak-value/);
});

test('top-level accessors and coercion hooks cannot influence telemetry dimensions',async()=>{
  let executed=0;
  const malicious={toString(){executed++;throw new Error('must not stringify');}};
  const input={
    event:'ei.wake.retry',
    status:malicious,
    attempt:malicious,
    metadata:{ nested:{id:'safe'} },
  };
  for(const key of ['traceId','error','nextAttemptAt','connectionId']) {
    Object.defineProperty(input,key,{
      enumerable:true,get(){executed++;return 'unlabelled-secret';},
    });
  }
  const records=[];
  const emitter=createObservabilityEmitter(row=>records.push(row),{
    now:()=>new Date('2026-10-18T00:00:00.000Z'),
  });
  assert.equal(await emitter.emit(input),true);
  assert.equal(executed,0);
  assert.equal(records[0].status,'[untrusted value]');
  assert.equal(records[0].attempt,undefined);
  assert.equal(records[0].traceId,undefined);
  assert.equal(records[0].error,undefined);
  assert.doesNotMatch(JSON.stringify(records),/unlabelled-secret/);
  const evilEvent={};
  Object.defineProperty(evilEvent,'event',{get(){executed++;return 'ei.wake.delivered';}});
  await assert.rejects(emitter.emit(evilEvent),/ei\.\* namespace/);
  const proxy=new Proxy({event:'ei.wake.delivered'},{
    getOwnPropertyDescriptor(){executed++;throw Error('untrusted');},
  });
  await assert.rejects(emitter.emit(proxy),/ei\.\* namespace/);
  assert.equal(executed,0);
  assert.equal(records.length,1);
});

test('Error metadata and failure projection never run custom accessors',async()=>{
  let executed=0;
  const error=new Error('token=sampleSecret');
  Object.defineProperty(error,'name',{get(){executed++;return 'Bearer sampleSecret';}});
  Object.defineProperty(error,'code',{get(){executed++;return 'token=sampleSecret';}});
  const safe=serializeObservabilityError(error);
  assert.equal(safe.name,'Error');
  assert.equal(safe.message,'token=[redacted]');
  assert.equal(safe.code,undefined);
  const exotic=new Proxy(new Error('secret'),{
    getPrototypeOf(){executed++;throw Error('do not inspect');},
    get(){executed++;throw Error('do not inspect');},
  });
  assert.deepEqual(serializeObservabilityError(exotic),{
    message:'[untrusted value]',
  });
  const rows=[];
  const emitter=createObservabilityEmitter(row=>rows.push(row));
  await emitter.emit({
    event:'ei.match.failed',
    error,
    metadata:{ nestedError:error, proxyError:exotic },
  });
  assert.equal(executed,0);
  assert.equal(rows[0].error.message,'token=[redacted]');
  assert.equal(rows[0].metadata.nestedError.message,'token=[redacted]');
  assert.equal(rows[0].metadata.proxyError,'[untrusted value]');
  assert.doesNotMatch(JSON.stringify(rows),/sampleSecret/);
});

test('dangerous metadata field names are data and cannot alter object prototype',async()=>{
  const metadata=Object.create(null);
  Object.defineProperty(metadata,'__proto__',{
    value:{malicious:true},enumerable:true,
  });
  metadata.safe='ok';
  const rows=[];
  await createObservabilityEmitter(row=>rows.push(row)).emit({
    event:'ei.test.safe',
    metadata,
  });
  assert.equal(Object.getPrototypeOf(rows[0].metadata),Object.prototype);
  assert.equal(({}).malicious,undefined);
  assert.deepEqual(Object.getOwnPropertyDescriptor(rows[0].metadata,'__proto__')?.value,
    {malicious:true});
  assert.equal(rows[0].metadata.safe,'ok');
});


test('Proxy in object prototype chain cannot run traps through Error checks',async()=>{
  let invoked=0;
  const maliciousProto=new Proxy({},{
    getPrototypeOf(){invoked++;throw new Error('prototype getter trap');},
    get(){invoked++;throw new Error('prototype property trap');},
    getOwnPropertyDescriptor(){invoked++;throw new Error('prototype descriptor trap');},
  });
  const inheritedProxy=Object.create(maliciousProto);
  Object.defineProperty(inheritedProxy,'safe',{
    enumerable:true, value:'hello',
  });
  assert.deepEqual(serializeObservabilityError(inheritedProxy),{
    message:'[untrusted value]',
  });
  const rows=[];
  const emitter=createObservabilityEmitter(row=>rows.push(row));
  assert.equal(await emitter.emit({
    event:'ei.security.prototype',
    metadata:{value:inheritedProxy,nested:[inheritedProxy]},
    error:inheritedProxy,
  }),true);
  assert.equal(invoked,0,'no prototype Proxy trap should run');
  assert.equal(rows[0].error.message,'[untrusted value]');
  assert.equal(rows[0].metadata.value,'[untrusted value]');
  assert.deepEqual(rows[0].metadata.nested,['[untrusted value]']);
  const branded=new Error('Bearer fakeCredential');
  Object.setPrototypeOf(branded,maliciousProto);
  assert.equal(await emitter.emit({
    event:'ei.security.error',
    error:branded,
    metadata:{error:branded},
  }),true);
  assert.equal(invoked,0,
    'even native Error with a Proxy prototype must avoid calling it');
  assert.equal(rows[1].error.name,'Error');
  assert.equal(rows[1].error.message,'Bearer [redacted]');
});
