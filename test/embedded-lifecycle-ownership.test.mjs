import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEmbeddedEventIntelligence,
  createEmbeddedRuntimeIntegration,
  createEventIntelligence,
} from '../scripts/embedded-host-kit.mjs';

function fakeHost(onClose) {
  return {
    runtime: { host: 'external' },
    eventSources: [],
    async refreshMcpRegistry() { return []; },
    async mcpStatus() { return []; },
    scope() { return this; },
    close: onClose,
  };
}

const activation = {
  deliver: () => ({ runtimeReceiptId: 'host-owned-receipt' }),
};

test('lower-level host is released when post-start agent-tools construction fails', async()=>{
  let started=0;
  let closed=0;
  await assert.rejects(
    createEmbeddedEventIntelligence({
      activation,
      agentTools:{
        resolveContext:()=>({}),
        control:()=>({action:'execute'}),
        names:{create:'same-tool',delete:'same-tool'},
      },
      createHost:async()=>{
        started++;
        return fakeHost(async()=>{closed++});
      },
    }),
    /Duplicate embedded tool name/,
  );
  assert.equal(started,1);
  assert.equal(closed,1,'no host subscriptions may survive rejected installation');
});

test('neutral facade releases host after invalid tool names and preserves original failure',async()=>{
  let closed=0;
  await assert.rejects(
    createEventIntelligence({
      runtime:{
        deliver:activation.deliver,
        resolveContext:()=>({}),
        control:()=>({action:'execute'}),
      },
      tooling:{
        resolveContext:()=>({}),
        control:()=>({action:'execute'}),
        names:{pause:'same-tool',resume:'same-tool'},
      },
      createHost:async()=>fakeHost(async()=>{closed++}),
    }),
    /Duplicate embedded tool name/,
  );
  assert.equal(closed,1);
});

test('runtime facade releases host after invalid model-facing tools',async()=>{
  let closed=0;
  await assert.rejects(
    createEmbeddedRuntimeIntegration({
      activation,
      tooling:{
        resolveContext:()=>({}),
        control:()=>({action:'execute'}),
        names:{create:'same-tool',list:'same-tool'},
      },
      createHost:async()=>fakeHost(async()=>{closed++}),
    }),
    /Duplicate embedded tool name/,
  );
  assert.equal(closed,1);
});

test('cleanup failure cannot mask configuration failure',async()=>{
  let closeCalls=0;
  await assert.rejects(
    createEmbeddedRuntimeIntegration({
      activation,
      tooling:{
        resolveContext:()=>({}),
        control:()=>({action:'execute'}),
        names:{list:'duplicate',inspect:'duplicate'},
      },
      createHost:async()=>fakeHost(async()=>{
        closeCalls++;
        throw new Error('host shutdown unavailable');
      }),
    }),
    /Duplicate embedded tool name/,
  );
  assert.equal(closeCalls,1);
});

test('explicit shutdown and multiple host onClose callbacks share one durable close',async()=>{
  let closeCalls=0;
  let release;
  const gate=new Promise(resolve=>{release=resolve});
  const integration=await createEventIntelligence({
    runtime:{
      deliver:activation.deliver,
      resolveContext:()=>({}),
      control:()=>({action:'execute'}),
    },
    createHost:async()=>fakeHost(async()=>{
      closeCalls++;
      await gate;
    }),
  });
  const shutdownHooks=[];
  const registered=[];
  const bind={
    adapt:(tool)=>({name:tool.name}),
    register:(tool)=>registered.push(tool.name),
    onClose:(callback)=>shutdownHooks.push(callback),
    capabilityIds:[],
  };
  integration.bind(bind);
  integration.bind(bind);
  assert.equal(registered.length,0);
  assert.equal(shutdownHooks.length,2);
  const first=integration.close();
  const second=integration.close();
  const third=shutdownHooks[0]();
  const fourth=shutdownHooks[1]();
  assert.equal(first,second);
  assert.equal(second,third);
  assert.equal(third,fourth);
  await Promise.resolve();
  assert.equal(closeCalls,1,'close is invoked exactly once during overlap');
  release();
  await Promise.all([first,second,third,fourth]);
  await integration.close();
  assert.equal(closeCalls,1,'close remains idempotent after it settles');
});

test('rejected shutdown remains shared rather than retrying an unsafe second close',async()=>{
  let closeCalls=0;
  const failure=new Error('storage close failure');
  const integration=await createEmbeddedEventIntelligence({
    activation,
    createHost:async()=>fakeHost(async()=>{
      closeCalls++;
      throw failure;
    }),
  });
  const [first,second]=await Promise.allSettled([
    integration.close(),integration.close(),
  ]);
  assert.equal(first.status,'rejected');
  assert.equal(second.status,'rejected');
  assert.equal(first.reason,failure);
  assert.equal(second.reason,failure);
  assert.equal(closeCalls,1);
  await assert.rejects(integration.close(),error=>error===failure);
  assert.equal(closeCalls,1);
});

test('invalid lifecycle host is rejected with a stable code',async()=>{
  await assert.rejects(
    createEmbeddedEventIntelligence({
      activation,
      createHost:async()=>({runtime:{},eventSources:[]}),
    }),
    error=>error instanceof TypeError&&error.code==='EI_HOST_LIFECYCLE_INVALID',
  );
});

test('host-owned registry remains supplied without extra transport ownership',async()=>{
  let receivedRegistry;
  const registry={list:()=>[],subscribe:()=>()=>{}};
  const integration=await createEventIntelligence({
    mcp:registry,
    runtime:{deliver:activation.deliver},
    createHost:async options=>{
      receivedRegistry=options.mcpRegistry;
      return fakeHost(async()=>{});
    },
  });
  assert.equal(typeof receivedRegistry.listConnections,'function');
  assert.deepEqual(await receivedRegistry.listConnections(),[]);
  assert.deepEqual(integration.tools,[]);
  await integration.close();
});
