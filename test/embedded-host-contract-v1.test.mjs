import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEventIntelligence,
  HOST_CONTRACT_CAPABILITIES,
  HOST_CONTRACT_VERSION,
  negotiateHostContract,
} from '../scripts/embedded-host-kit.mjs';

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
