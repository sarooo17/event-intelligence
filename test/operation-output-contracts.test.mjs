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
  assert.deepEqual(Object.keys(OPERATION_OUTPUT_CONTRACTS),[
    'sources','list',
  ]);
  assert.equal(outputValidator('stdio','sources'),
    outputValidator('embedded','sources'));
  assert.notEqual(outputValidator('stdio','list'),
    outputValidator('embedded','list'));
  for (const key of ['sources','list']) {
    for (const surface of ['stdio','embedded']) {
      const json=outputJsonSchema(surface,key);
      assert.equal(json.type,'object');
      assert.equal(Object.isFrozen(OPERATION_OUTPUT_CONTRACTS[key]),true);
    }
  }
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
