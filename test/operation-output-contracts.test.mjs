import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OPERATION_OUTPUT_CONTRACTS,
  OPERATION_OUTPUT_CONTRACT_VERSION,
  outputJsonSchema,
  outputValidator,
  validateOperationOutput,
} from '../scripts/lib/operation-output-contracts.mjs';
import {
  createEventIntelligenceAgentTools,
} from '../scripts/embedded-host-kit.mjs';

test('three shared semantic output operations expose intentional transport projections', () => {
  assert.equal(OPERATION_OUTPUT_CONTRACT_VERSION, '1');
  assert.deepEqual(Object.keys(OPERATION_OUTPUT_CONTRACTS), [
    'sources', 'list', 'plan',
  ]);
  assert.equal(outputValidator('stdio','sources'),
    outputValidator('embedded','sources'));
  assert.notEqual(outputValidator('stdio','list'),
    outputValidator('embedded','list'));
  for (const key of ['sources', 'list', 'plan']) {
    const surfaces = key === 'plan' ? ['stdio'] : ['stdio', 'embedded'];
    for (const surface of surfaces) {
      const json = outputJsonSchema(surface, key);
      assert.equal(json.type, 'object');
      assert.equal(Object.isFrozen(OPERATION_OUTPUT_CONTRACTS[key]), true);
    }
  }
  assert.throws(() => outputValidator('embedded', 'plan'),
    /Operation not exposed on EI surface/);
});

test('runtime output validation rejects missing/wrong shapes without mutating data',()=>{
  for(const surface of ['stdio','embedded']){
    for(const [operation,bad] of [
      ['sources',{sources:'not-an-array'}],
      ['list',{triggers:'not-an-array'}],
    ]) {
      assert.throws(()=>validateOperationOutput(surface,operation,bad),
        err=>err.code==='EI_OUTPUT_CONTRACT_INVALID');
    }
  }
  assert.throws(()=>validateOperationOutput('embedded','list',
    {triggers:[],total:-1,returned:0}),
    err=>err.code==='EI_OUTPUT_CONTRACT_INVALID');
  assert.deepEqual(validateOperationOutput('stdio','list',
    {triggers:[]}),{triggers:[]});
  assert.throws(()=>outputValidator('muffin','list'),/Unknown EI output surface/);
  assert.throws(()=>outputValidator('stdio','create'),/Unmodeled/);
  const validPlan = {
    planVersion: '2',
    definition: { triggerId: 'test' },
    connectionIds: ['source-1'],
    resolvedSources: [],
    warnings: [],
    explanation: { when: {}, then: {} },
  };
  assert.equal(validateOperationOutput('stdio', 'plan', validPlan), validPlan);
  for (const invalid of [
    { ...validPlan, planVersion: 'unknown' },
    { ...validPlan, connectionIds: 'wrong' },
    { ...validPlan, explanation: { when: {} } },
    { ...validPlan, definition: null },
  ]) {
    assert.throws(() => validateOperationOutput('stdio', 'plan', invalid),
      err => err.code === 'EI_OUTPUT_CONTRACT_INVALID');
  }
});

test('real embedded list validates canonical projected response before host projection',async()=>{
  let projected=0;
  const tools=createEventIntelligenceAgentTools({
    host:{
      triggerControl:{async listTriggers(){return [];}},
    },
    resolveContext:()=>({
      owner:{type:'user',principal_id:'owner-1'},
      actor:{type:'agent',principal_id:'agent-1'},
    }),
    control:()=>({action:'return',result:{ok:false}}),
    projectResult:({value})=>{
      projected++;
      return {inline:value};
    },
  });
  const list=tools.find(item=>item.name==='trigger_list');
  assert.ok(list?.outputSchema);
  const result=await list.execute({},{});
  assert.equal(result.ok,true);
  assert.deepEqual(result.data,{triggers:[],total:0,returned:0});
  assert.equal(projected,1);
  for(const key of ['event_sources_list']){
    assert.ok(tools.find(item=>item.name===key)?.outputSchema);
  }
  for(const key of ['trigger_create','trigger_pause','trigger_update','trigger_inspect']){
    assert.equal(tools.find(item=>item.name===key)?.outputSchema,undefined);
  }
});
