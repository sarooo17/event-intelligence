import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEventIntelligence,
  HOST_CONTRACT_CAPABILITIES,
  HOST_CONTRACT_VERSION,
  negotiateHostContract,
} from '../scripts/embedded-host-kit.mjs';
import {
  REQUIRED_EVENT_STORE_METHODS,
} from '../scripts/lib/store-capabilities.mjs';

const deliver = () => ({ runtimeReceiptId: 'host-owned' });
const runtime = { deliver };
const contract = required => ({version:'1',required});

test('contract IDs and negotiation result have versioned immutable shape',()=>{
  assert.equal(HOST_CONTRACT_VERSION,'1');
  assert.equal(Object.isFrozen(HOST_CONTRACT_CAPABILITIES),true);
  const result=negotiateHostContract(contract([
    'mcp.registry','storage.durable','wake.receipts',
    'tooling.owner-scoped','semantic.evaluate','observability.sink',
  ]),{
    mcp:{list:()=>[]},
    dataDir:'/temporary/host-controlled-state',
    runtime:{
      deliver,
      hasReceipt:()=>false,
      receiptNamespace:'host-instance',
      resolveContext:()=>({}),
      control:()=>({action:'return',result:{ok:false}}),
    },
    semanticEvaluator:{evaluate:async()=>({matched:false})},
    observability:()=>{},
  });
  assert.equal(result.schema,'event-intelligence.host-contract.v1');
  assert.equal(result.version,'1');
  assert.equal(result.readiness,'configuration-validated');
  assert.equal(result.required.length,6);
  for(const id of result.required)assert.equal(result.available[id],true,id);
  assert.equal(result.available['storage.shared'],false);
  assert.equal(Object.isFrozen(result),true);
  assert.equal(Object.isFrozen(result.available),true);
  assert.equal(Object.isFrozen(result.required),true);
  assert.throws(()=>result.required.push('storage.shared'),TypeError);
  assert.throws(()=>Object.assign(result.available,{'mcp.registry':false}),TypeError);
});

test('unsupported, malformed, ambiguous and undeclared host requirements fail before starting EI',async()=>{
  const probes=[
    [{version:'2',required:[]},'EI_HOST_CONTRACT_VERSION_UNSUPPORTED'],
    [{required:[]},'EI_HOST_CONTRACT_VERSION_UNSUPPORTED'],
    [{version:'1'},'EI_HOST_CONTRACT_INVALID'],
    [{version:'1',required:'wake.receipts'},'EI_HOST_CONTRACT_INVALID'],
    [{version:'1',required:['mcp.registry','mcp.registry']},'EI_HOST_CONTRACT_INVALID'],
    [{version:'1',required:['unknown.capability']},'EI_HOST_CAPABILITY_UNKNOWN'],
    [{version:'1',required:[],permissions:'allow'},'EI_HOST_CONTRACT_INVALID'],
    [contract(['mcp.registry']),'EI_HOST_CAPABILITY_UNAVAILABLE'],
    [contract(['wake.receipts']),'EI_HOST_CAPABILITY_UNAVAILABLE'],
    [contract(['tooling.owner-scoped']),'EI_HOST_CAPABILITY_UNAVAILABLE'],
    [contract(['storage.durable']),'EI_HOST_STORAGE_REQUIRED'],
    [contract(['semantic.evaluate']),'EI_HOST_CAPABILITY_UNAVAILABLE'],
    [contract(['observability.sink']),'EI_HOST_CAPABILITY_UNAVAILABLE'],
    [contract(['storage.shared']),'EI_HOST_SHARED_STORE_REQUIRED'],
  ];
  for(const [requested,code] of probes) {
    let started=0;
    await assert.rejects(createEventIntelligence({
      runtime,
      hostContract:requested,
      env:{ DATA_DIR:'' }, // override any injected CI process env
      createHost:async()=>{
        started++;
        throw Error('host must not start');
      },
    }),error=>{
      assert.equal(error instanceof TypeError,true,code);
      assert.equal(error.code,code);
      assert.ok(!error.message.includes('secret'));
      return true;
    },code);
    assert.equal(started,0,code);
  }
});

test('shared state cannot be negotiated from a claimed flag without atomic primitives',()=>{
  const falselyAdvertised={
    storeCapabilities:()=>({
      version:'1',sharedState:'strong',scopeIsolation:'strong',
      wakeClaims:'distributed-atomic',partitionLeases:'distributed-atomic',
    }),
    putTrigger:async()=>{},
    getWakeDelivery:async()=>null,
    completeWakeDelivery:async()=>{},
  };
  assert.throws(()=>negotiateHostContract(contract(['storage.shared']),{
    runtime,
    store:falselyAdvertised,
  }),error=>error?.code==='EI_HOST_SHARED_STORE_REQUIRED',
  'a host must implement its claimed distributed store operations');
  const fullStore={
    ...Object.fromEntries(REQUIRED_EVENT_STORE_METHODS.map(name=>
      [name,async()=>null])),
    ...falselyAdvertised,
    claimPartitionLease:async()=>null,
    renewPartitionLease:async()=>null,
    releasePartitionLease:async()=>null,
    compareAndAppendTriggerMatch:async()=>null,
  };
  assert.equal(negotiateHostContract(contract(['storage.shared']),{
    runtime,store:fullStore,
  }).available['storage.shared'],true);
});

test('host facade returns negotiated readiness only when explicitly requested',async()=>{
  let calls=0;
  let closes=0;
  let receivedOptions;
  const createHost=async(options)=>{
    calls++;
    receivedOptions=options;
    return {
      eventSources:[],
      runtime:{},
      async refreshMcpRegistry(){return []},
      async mcpStatus(){return []},
      async close(){closes++},
    };
  };
  const chosen=await createEventIntelligence({
    hostContract:contract(['mcp.registry','storage.durable','wake.receipts']),
    runtime:{
      deliver,
      receiptNamespace:'host-app',
      hasReceipt:()=>false,
    },
    mcp:{list:()=>[]},
    dataDir:'/test/opaque-state',
    createHost,
  });
  assert.equal(calls,1);
  assert.equal(chosen.hostContract.schema,'event-intelligence.host-contract.v1');
  assert.equal(chosen.hostContract.available['wake.receipts'],true);
  assert.equal(receivedOptions.hostContract,undefined,
    'negotiation metadata must not leak into host factory or create alternative engine');
  await chosen.close();
  assert.equal(closes,1);
  const plain=await createEventIntelligence({runtime,createHost});
  assert.equal(plain.hostContract,undefined);
  await plain.close();
  assert.equal(calls,2);
  assert.equal(closes,2);
});

test('handshake never invokes host authorization, MCP listing or receipt callbacks',()=>{
  let effects=0;
  const guard=()=>{effects++;throw Error('should not execute side effect')};
  const readiness=negotiateHostContract(
    contract(['mcp.registry','wake.receipts','tooling.owner-scoped']),{
      mcp:{list:guard,subscribe:guard},
      runtime:{
        deliver:guard,hasReceipt:guard,receiptId:guard,
        control:guard,resolveContext:guard,
      },
    });
  assert.equal(readiness.available['mcp.registry'],true);
  assert.equal(readiness.available['wake.receipts'],true);
  assert.equal(readiness.available['tooling.owner-scoped'],true);
  assert.equal(effects,0,'no live transport, auth or persistence callbacks during config negotiation');
});


test('unrelated handshake never invokes throwing store capability metadata',()=>{
  let calls=0;
  const malformedStore={
    storeCapabilities:()=>{calls++;throw new Error('unsafe host callback contents');},
  };
  const result=negotiateHostContract(contract(['mcp.registry']),{
    mcp:{list:()=>[]},
    runtime,store:malformedStore,
  });
  assert.equal(result.available['mcp.registry'],true);
  assert.equal(result.available['storage.shared'],false,
    'unrequested shared-mode capability is not probed');
  assert.equal(calls,0);
  assert.throws(()=>negotiateHostContract(contract(['storage.shared']),{
    runtime,store:malformedStore,
  }),error=>error?.code==='EI_HOST_SHARED_STORE_REQUIRED'&&
    !error.message.includes('unsafe host callback contents'));
  assert.equal(calls,0,
    'a store missing durable methods is rejected before metadata callbacks');
  const fullShape={...Object.fromEntries(
    REQUIRED_EVENT_STORE_METHODS.map(name=>[name,async()=>null])),
    storeCapabilities:malformedStore.storeCapabilities,
    claimPartitionLease:async()=>null,
    renewPartitionLease:async()=>null,
    releasePartitionLease:async()=>null,
    compareAndAppendTriggerMatch:async()=>null,
  };
  assert.throws(()=>negotiateHostContract(contract(['storage.shared']),{
    runtime,store:fullShape,
  }),error=>error?.code==='EI_HOST_SHARED_STORE_REQUIRED'&&
    !error.message.includes('unsafe host callback contents'));
  assert.equal(calls,1);
});

test('durable store handshake checks every method before custom init can mutate state',async()=>{
  let initialized=0;
  const partial={
    putTrigger:async()=>{},
    getWakeDelivery:async()=>null,
    completeWakeDelivery:async()=>{},
    init:async()=>{initialized++;throw new Error('unsafe initialization');},
  };
  let starts=0;
  await assert.rejects(createEventIntelligence({
    runtime,
    hostContract:contract(['storage.durable']),
    store:partial,
    createHost:async()=>{starts++;await partial.init()},
  }),error=>error?.code==='EI_HOST_STORAGE_REQUIRED');
  assert.equal(initialized,0);
  assert.equal(starts,0);
  const fullStore=Object.fromEntries(REQUIRED_EVENT_STORE_METHODS.map(name=>
    [name,async()=>null]));
  assert.equal(negotiateHostContract(contract(['storage.durable']),{
    runtime,store:fullStore,
  }).available['storage.durable'],true);
});

test('semantic capability requires a runtime-supported evaluator object',async()=>{
  let starts=0;
  await assert.rejects(createEventIntelligence({
    runtime,hostContract:contract(['semantic.evaluate']),
    semanticEvaluator:()=>({matched:true}),
    createHost:async()=>{starts++},
  }),error=>error?.code==='EI_HOST_CAPABILITY_UNAVAILABLE');
  assert.equal(starts,0);
  assert.equal(negotiateHostContract(contract(['semantic.evaluate']),{
    runtime,semanticEvaluator:{evaluate:async()=>({matched:true})},
  }).available['semantic.evaluate'],true);
});

test('canonical facade handshake recognizes the same process env DATA_DIR as the host',()=>{
  const previous=process.env.DATA_DIR;
  try {
    process.env.DATA_DIR='/tmp/host-state-from-environment';
    assert.equal(negotiateHostContract(contract(['storage.durable']),{
      runtime,
    }).available['storage.durable'],true);
    assert.throws(()=>negotiateHostContract(contract(['storage.durable']),{
      runtime,env:{DATA_DIR:''},
    }),error=>error?.code==='EI_HOST_STORAGE_REQUIRED',
    'explicit host env override must supersede ambient process env');
  } finally {
    if(previous===undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR=previous;
  }
});


test('host store metadata accessors and Proxy traps fail closed without exposing private error',()=>{
  let invoked=0;
  const full=Object.fromEntries(REQUIRED_EVENT_STORE_METHODS.map(name=>
    [name,async()=>null]));
  const secret='private_metadata_credential_do_not_repeat';
  Object.defineProperty(full,'storeCapabilities',{
    get(){invoked++;throw new Error(secret);},
  });
  const input={runtime,store:full};
  assert.throws(()=>negotiateHostContract(contract(['storage.shared']),input),
    error=>error?.code==='EI_HOST_SHARED_STORE_REQUIRED'&&
      !error.message.includes(secret));
  assert.equal(invoked,0,
    'native descriptor inspection must not execute getter');
  assert.equal(negotiateHostContract(contract(['storage.durable']),input)
    .available['storage.durable'],true,
    'unrelated durable shape does not access shared descriptor getter');
  assert.equal(invoked,0);

  const proxy=new Proxy(Object.fromEntries(REQUIRED_EVENT_STORE_METHODS.map(name=>
    [name,async()=>null])),{
    get(target,key,receiver) {
      if(key==='storeCapabilities'){
        invoked++;
        throw new Error(secret);
      }
      return Reflect.get(target,key,receiver);
    },
  });
  assert.throws(()=>negotiateHostContract(contract(['storage.shared']),{
    runtime,store:proxy,
  }),error=>error?.code==='EI_HOST_SHARED_STORE_REQUIRED'&&
    !error.message.includes(secret));
  assert.equal(invoked,0,
    'host proxy is rejected without calling its property traps');

  const getterStore=Object.create(null);
  Object.defineProperty(getterStore,'putTrigger',{
    get(){invoked++;throw new Error(secret);},
  });
  assert.throws(()=>negotiateHostContract(contract(['storage.durable']),{
    runtime,store:getterStore,
  }),error=>error?.code==='EI_HOST_STORAGE_REQUIRED'&&
    !error.message.includes(secret));
  assert.equal(invoked,0,
    'dynamic custom-store method getter must not be evaluated');
});


test('stateful store method accessors cannot initialize before runtime rejection',async()=>{
  let getterCalls=0;
  let initCalls=0;
  const methods=Object.fromEntries(REQUIRED_EVENT_STORE_METHODS.map(name=>
    [name,async()=>null]));
  const volatile={...methods,
    async init(){initCalls++},
  };
  Object.defineProperty(volatile,'putTrigger',{
    enumerable:true,
    configurable:true,
    get(){
      getterCalls++;
      return getterCalls===1 ? async()=>{} : undefined;
    },
  });
  await assert.rejects(createEventIntelligence({
    runtime,hostContract:contract(['storage.durable']),
    store:volatile,
    createHost:async()=>{throw new Error('factory unexpectedly called')},
  }),e=>e.code==='EI_HOST_STORAGE_REQUIRED');
  assert.equal(getterCalls,0,
    'stateful getter must never satisfy durable method preflight');
  assert.equal(initCalls,0,
    'configuration rejected before custom storage initialization');

  const { createEventIntelligenceHost } =
    await import('../scripts/host-integration.mjs');
  await assert.rejects(createEventIntelligenceHost({
    store:volatile,
    env:{TYPESAFE_API_KEY:'',RUNTIME_WAKE_TARGETS_JSON:'{}'},
  }),e=>e.code==='EVENT_INTELLIGENCE_STORE_INVALID');
  assert.equal(getterCalls,0);
  assert.equal(initCalls,0,
    'the runtime must assert methods before calling store.init() directly');
});

test('semantic evaluator accessors and proxies are not inspected outside requirements',()=>{
  let invoked=0;
  const evaluator=Object.create(null);
  Object.defineProperty(evaluator,'evaluate',{
    get(){invoked++;throw new Error('semantic-private-credential');},
  });
  assert.equal(negotiateHostContract(contract(['mcp.registry']),{
    runtime,mcp:{list:()=>[]},semanticEvaluator:evaluator,
  }).available['semantic.evaluate'],false);
  assert.equal(invoked,0,'unrequested semantic descriptor is not inspected');
  assert.throws(()=>negotiateHostContract(contract(['semantic.evaluate']),{
    runtime,semanticEvaluator:evaluator,
  }),e=>e.code==='EI_HOST_CAPABILITY_UNAVAILABLE'&&
    !e.message.includes('semantic-private-credential'));
  assert.equal(invoked,0,'getter is not executed even when semantic is required');

  const proxy=new Proxy({evaluate:async()=>true},{
    get(){invoked++;throw new Error('proxy semantic trap')},
    getOwnPropertyDescriptor(){invoked++;throw new Error('proxy reflection')},
  });
  assert.throws(()=>negotiateHostContract(contract(['semantic.evaluate']),{
    runtime,semanticEvaluator:proxy,
  }),e=>e.code==='EI_HOST_CAPABILITY_UNAVAILABLE');
  assert.equal(invoked,0,'Proxy-backed evaluator cannot attest capability');
});


test('temporal scheduler methods are required for durable store before init',async()=>{
  let initCalls=0;
  const complete=Object.fromEntries(REQUIRED_EVENT_STORE_METHODS.map(name=>
    [name,async()=>null]));
  const incomplete={...complete,
    init:async()=>{initCalls++;},
  };
  delete incomplete.listDueTemporalDeadlines;
  let factoryCalls=0;
  await assert.rejects(createEventIntelligence({
    runtime,store:incomplete,
    hostContract:contract(['storage.durable']),
    createHost:async()=>{factoryCalls++;await incomplete.init();},
  }),error=>error?.code==='EI_HOST_STORAGE_REQUIRED');
  assert.equal(factoryCalls,0);
  assert.equal(initCalls,0);
  assert.ok(REQUIRED_EVENT_STORE_METHODS.includes('getTemporalDeadline'));
  assert.ok(REQUIRED_EVENT_STORE_METHODS.includes('setTemporalDeadlineStatus'));
  assert.ok(REQUIRED_EVENT_STORE_METHODS.includes('listDueTemporalDeadlines'));
});

test('observability sink readiness never evaluates getters and is lazy',()=>{
  let getterCalls=0;
  const sink={};
  Object.defineProperty(sink,'emit',{
    get(){getterCalls++;throw Error('host-private-observability-secret');},
  });
  const ready=negotiateHostContract(contract(['mcp.registry']),{
    mcp:{list:()=>[]},runtime,observability:sink,
  });
  assert.equal(ready.available['mcp.registry'],true);
  assert.equal(ready.available['observability.sink'],false);
  assert.equal(getterCalls,0);
  assert.throws(()=>negotiateHostContract(contract(['observability.sink']),{
    runtime,observability:sink,
  }),error=>error.code==='EI_HOST_CAPABILITY_UNAVAILABLE' &&
    !error.message.includes('host-private-observability-secret'));
  assert.equal(getterCalls,0);
  const proxy=new Proxy({emit:()=>{}},{
    get(){getterCalls++;throw Error('host-private-observability-secret');},
    getOwnPropertyDescriptor(){getterCalls++;throw Error('host-private-observability-secret');},
  });
  assert.throws(()=>negotiateHostContract(contract(['observability.sink']),{
    runtime,observability:proxy,
  }),error=>error.code==='EI_HOST_CAPABILITY_UNAVAILABLE');
  assert.equal(getterCalls,0);
  const valid={emit(){}};
  assert.equal(negotiateHostContract(contract(['observability.sink']),{
    runtime,observability:valid,
  }).available['observability.sink'],true);
});


test('derived-event contract storage is mandatory before starting an embedded host',async()=>{
  const store=Object.fromEntries(REQUIRED_EVENT_STORE_METHODS.map(name=>
    [name,async()=>null]));
  let initialized=0;
  store.init=async()=>{initialized++};
  for(const required of [
    'listDerivedContracts','getDerivedContract','putDerivedContract',
    'getDerivedEvent','appendDerivedEvent','listDerivedEvents',
  ]) {
    const broken={...store};
    delete broken[required];
    await assert.rejects(createEventIntelligence({
      runtime,store:broken,hostContract:contract(['storage.durable']),
      createHost:async()=>{await broken.init()},
    }),error=>error.code==='EI_HOST_STORAGE_REQUIRED',required);
  }
  assert.equal(initialized,0);
});


test('MCP registry negotiation is lazy and never evaluates getters or Proxy traps', async()=>{
  let getterCalls=0;
  let starts=0;
  const secret='private-registry-credential';
  const hostMcp={};
  Object.defineProperty(hostMcp,'list',{
    get(){getterCalls++;throw new Error(secret);},
  });
  assert.equal(negotiateHostContract(contract(['storage.durable']),{
    mcp:hostMcp,dataDir:'/host-storage',runtime,
  }).available['mcp.registry'],false);
  assert.equal(getterCalls,0,'an unrelated requirement must not probe the MCP registry');
  await assert.rejects(createEventIntelligence({
    runtime,mcp:hostMcp,hostContract:contract(['mcp.registry']),
    createHost:async()=>{starts++},
  }),error=>error?.code==='EI_HOST_CAPABILITY_UNAVAILABLE'&&
    !error.message.includes(secret));
  assert.equal(starts,0);
  assert.equal(getterCalls,0,'mcp.list getter cannot execute during negotiation');

  const subscribed={list:()=>[]};
  Object.defineProperty(subscribed,'subscribe',{
    get(){getterCalls++;throw new Error(secret);},
  });
  assert.throws(()=>negotiateHostContract(contract(['mcp.registry']),{
    runtime,mcp:subscribed,
  }),error=>error?.code==='EI_HOST_CAPABILITY_UNAVAILABLE'&&
    !error.message.includes(secret));
  assert.equal(getterCalls,0,'mcp.subscribe getter cannot execute during negotiation');

  const registryProxy=new Proxy({list:()=>[],subscribe:()=>{}},{
    get(){getterCalls++;throw new Error(secret)},
    getOwnPropertyDescriptor(){getterCalls++;throw new Error(secret)},
    getPrototypeOf(){getterCalls++;throw new Error(secret)},
  });
  assert.throws(()=>negotiateHostContract(contract(['mcp.registry']),{
    runtime,mcp:registryProxy,
  }),error=>error?.code==='EI_HOST_CAPABILITY_UNAVAILABLE'&&
    !error.message.includes(secret));
  assert.equal(getterCalls,0,'Proxy traps are not preflight evidence');

  const valid=negotiateHostContract(contract(['mcp.registry']),{
    runtime,mcp:{list:()=>[]},
  });
  assert.equal(valid.available['mcp.registry'],true,
    'a normal registry without the optional subscribe callback is supported');
  assert.equal(negotiateHostContract(contract(['mcp.registry']),{
    runtime,mcp:{list:()=>[],subscribe:()=>{}},
  }).available['mcp.registry'],true);
  assert.throws(()=>negotiateHostContract(contract(['mcp.registry']),{
    runtime,mcp:{list:()=>[],subscribe:'not callable'},
  }),error=>error?.code==='EI_HOST_CAPABILITY_UNAVAILABLE');
});


test('HostContract runtime callback inspection is lazy, descriptor-only, and fail-closed',async()=>{
  const secret='private-runtime-credential';
  let traps=0;
  const goodMcp={list:()=>[]};
  for(const [name,requires,base] of [
    ['hasReceipt','wake.receipts',{}],
    ['receiptId','wake.receipts',{hasReceipt:()=>false}],
    ['receiptNamespace','wake.receipts',{hasReceipt:()=>false}],
    ['resolveContext','tooling.owner-scoped',{control:()=>{}}],
    ['control','tooling.owner-scoped',{resolveContext:()=>{}}],
  ]) {
    const unsafe={deliver,...base};
    Object.defineProperty(unsafe,name,{
      get(){traps++;throw new Error(secret);},
    });
    assert.equal(negotiateHostContract(contract(['mcp.registry']),{
      runtime:unsafe,mcp:goodMcp,
    }).available['mcp.registry'],true,name);
    assert.throws(()=>negotiateHostContract(contract([requires]),{
      runtime:unsafe,mcp:goodMcp,
    }),error=>error?.code==='EI_HOST_CAPABILITY_UNAVAILABLE' &&
      !error.message.includes(secret),name);
    assert.equal(traps,0,name+' getter must not execute');
  }
  let starts=0;
  const facadeRuntime={deliver};
  Object.defineProperty(facadeRuntime,'hasReceipt',{
    get(){traps++;throw new Error(secret);},
  });
  await assert.rejects(createEventIntelligence({
    runtime:facadeRuntime,mcp:goodMcp,
    hostContract:contract(['mcp.registry']),
    createHost:async()=>{starts++;},
  }),error=>error?.code==='EI_HOST_CALLBACK_INVALID' &&
    !error.message.includes(secret));
  assert.equal(traps,0);
  assert.equal(starts,0);

  const runtimeProxy=new Proxy({deliver,hasReceipt:()=>false},{
    get(){traps++;throw new Error(secret)},
    getOwnPropertyDescriptor(){traps++;throw new Error(secret)},
    getPrototypeOf(){traps++;throw new Error(secret)},
  });
  assert.equal(negotiateHostContract(contract(['mcp.registry']),{
    runtime:runtimeProxy,mcp:goodMcp,
  }).available['mcp.registry'],true);
  assert.throws(()=>negotiateHostContract(contract(['wake.receipts']),{
    runtime:runtimeProxy,mcp:goodMcp,
  }),error=>error?.code==='EI_HOST_CAPABILITY_UNAVAILABLE');
  assert.equal(traps,0,'Proxy traps cannot supply runtime readiness');
});

test('durability handshake defers hostile env reads and uses only own data descriptors',()=>{
  const secret='private-environment-credential';
  let traps=0;
  const evilEnv={};
  Object.defineProperty(evilEnv,'DATA_DIR',{
    get(){traps++;throw new Error(secret);},
  });
  const goodMcp={list:()=>[]};
  assert.equal(negotiateHostContract(contract(['mcp.registry']),{
    mcp:goodMcp,runtime,env:evilEnv,
  }).available['storage.durable'],false);
  assert.throws(()=>negotiateHostContract(contract(['storage.durable']),{
    runtime,env:evilEnv,
  }),error=>error?.code==='EI_HOST_STORAGE_REQUIRED' &&
    !error.message.includes(secret));
  assert.equal(traps,0,'env getter must never run');
  const evilProxy=new Proxy({DATA_DIR:'/private/path'},{
    get(){traps++;throw new Error(secret)},
    getOwnPropertyDescriptor(){traps++;throw new Error(secret)},
    getPrototypeOf(){traps++;throw new Error(secret)},
  });
  assert.throws(()=>negotiateHostContract(contract(['storage.durable']),{
    runtime,env:evilProxy,
  }),error=>error?.code==='EI_HOST_STORAGE_REQUIRED');
  assert.equal(traps,0,'env Proxy traps must never run');
  assert.equal(negotiateHostContract(contract(['storage.durable']),{
    runtime,env:{DATA_DIR:'/host-data'},
  }).available['storage.durable'],true);
});

test('an explicitly undefined optional MCP subscribe callback remains supported',async()=>{
  const mcp={list:()=>[],subscribe:undefined};
  assert.equal(negotiateHostContract(contract(['mcp.registry']),{
    runtime,mcp,
  }).available['mcp.registry'],true);
  let created=0;
  const integration=await createEventIntelligence({
    runtime,mcp,hostContract:contract(['mcp.registry']),
    createHost:async()=>{
      created++;
      return {
        eventSources:[],runtime:{},
        async refreshMcpRegistry(){return []},
        async mcpStatus(){return []},
        async close(){},
      };
    },
  });
  assert.equal(created,1);
  assert.equal(integration.hostContract.available['mcp.registry'],true);
  await integration.close();
});
