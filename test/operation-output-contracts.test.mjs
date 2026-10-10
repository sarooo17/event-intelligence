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
    'sources', 'list', 'plan', 'inspect', 'simulate', 'wakeHydrate',
    'create', 'update', 'pause', 'resume', 'delete',
    'languageDescribe', 'derivedContracts', 'runtimeStatus',
  ]);
  assert.equal(outputValidator('stdio','sources'),
    outputValidator('embedded','sources'));
  assert.notEqual(outputValidator('stdio','list'),
    outputValidator('embedded','list'));
  for (const key of Object.keys(OPERATION_OUTPUT_CONTRACTS)) {
    const surfaces = ['sources', 'list'].includes(key) ? ['stdio', 'embedded'] : ['stdio'];
    for (const surface of surfaces) {
      const json = outputJsonSchema(surface, key);
      assert.equal(json.type, 'object');
      assert.equal(Object.isFrozen(OPERATION_OUTPUT_CONTRACTS[key]), true);
    }
  }
  assert.throws(() => outputValidator('embedded', 'plan'),
    /Operation not exposed on EI surface/);
  for (const operation of ['inspect', 'create', 'update', 'pause', 'resume', 'delete']) {
    // The host may supply an inspector, but its arbitrary projection has no
    // portable output contract. Never return undefined as a validator.
    assert.throws(() => outputValidator('embedded', operation),
      /Unmodeled EI output projection/);
  }
  for (const operation of ['simulate', 'wakeHydrate', 'languageDescribe', 'derivedContracts', 'runtimeStatus']) {
    assert.throws(() => outputValidator('embedded', operation),
      /Operation not exposed on EI surface/);
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
  assert.throws(()=>outputValidator('stdio','operationThatDoesNotExist'),/Unmodeled/);
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
  const examples = [
    ['languageDescribe', {
      version: '3', authoringSurface: 'TriggerPlanInput',
      planner: 'trigger_plan', preferredAuthoring: 'TriggerPlanInput.pattern',
      canonicalRepresentation: 'CompositeTriggerDefinition.pattern',
      pattern: [],
    }, { version: '2' }],
    ['derivedContracts', { contracts: [] }, { contracts: null }],
    ['runtimeStatus', {
      restored: {}, hostMcpEventConnections: [],
      pendingTemporalDeadlines: 0, derivedEvents: 0,
      derivedContracts: 0, writeEnabled: false,
    }, { restored: {}, hostMcpEventConnections: [], pendingTemporalDeadlines: -1,
         derivedEvents: 0, derivedContracts: 0, writeEnabled: false }],
  ];
  for (const [operation, valid, invalidFields] of examples) {
    assert.equal(validateOperationOutput('stdio', operation, valid), valid);
    assert.throws(
      () => validateOperationOutput('stdio', operation, { ...valid, ...invalidFields }),
      error => error.code === 'EI_OUTPUT_CONTRACT_INVALID',
      operation,
    );
  }
});


test('read-only inspector and simulator output contracts reject malformed wire envelopes', () => {
  const inspection = {
    trigger: { triggerId: 'trigger-1', version: '1', pattern: {} },
    lifecycle: { status: 'active' },
    match: null,
    clauses: [{ clauseId: 'ready', status: 'waiting', observedCount: 0 }],
    evidenceSummary: {
      selectionBasis: 'no_match', observedClauseIds: [],
      unobservedClauseIds: ['ready'], pendingDeadlineCount: 0,
    },
    deadlines: [],
    nextEvaluationAt: null,
    wake: null,
    lineage: {
      evidence: [], derivedOutputs: [], matchHistory: [],
      historyTruncated: false, historyLimit: null,
    },
    why: { code: 'waiting_for_pattern_evidence', summary: 'Awaiting events' },
  };
  assert.equal(validateOperationOutput('stdio', 'inspect', inspection), inspection);
  for (const bad of [
    { ...inspection, clauses: 'not-an-array' },
    { ...inspection, why: { code: '', summary: 'missing' } },
    { ...inspection, evidenceSummary: { ...inspection.evidenceSummary, pendingDeadlineCount: -1 } },
    { ...inspection, lineage: { ...inspection.lineage, matchHistory: null } },
  ]) {
    assert.throws(
      () => validateOperationOutput('stdio', 'inspect', bad),
      error => error.code === 'EI_OUTPUT_CONTRACT_INVALID',
    );
  }

  const simulation = {
    isolated: true, order: 'provided',
    evaluatedUntil: '2026-10-10T12:00:00.000Z',
    steps: [], inspection, auditRecords: 0,
  };
  assert.equal(validateOperationOutput('stdio', 'simulate', simulation), simulation);
  for (const bad of [
    { ...simulation, isolated: false },
    { ...simulation, order: 'random' },
    { ...simulation, evaluatedUntil: '2026-10-10' },
    { ...simulation, inspection: { ...inspection, trigger: null } },
    { ...simulation, auditRecords: -1 },
  ]) {
    assert.throws(
      () => validateOperationOutput('stdio', 'simulate', bad),
      error => error.code === 'EI_OUTPUT_CONTRACT_INVALID',
    );
  }

  const schema = outputJsonSchema('stdio', 'wakeHydrate');
  assert.equal(schema.properties.activationVersion.const, '2');
  assert.ok(schema.required.includes('trust'));
  assert.throws(
    () => validateOperationOutput('stdio', 'wakeHydrate', {
      activationVersion: '2',
      trust: { evidence: 'trusted_external_signal' },
    }),
    error => error.code === 'EI_OUTPUT_CONTRACT_INVALID',
  );
});

test('stdio mutation outputs require coherent durable receipts and canonical definitions', async () => {
  const { parseCompositeTriggerDefinition } = await import(
    '../dist/src/intelligenceProtocol/index.js'
  );
  const definition = parseCompositeTriggerDefinition({
    triggerId: 'mutation-output-1', version: '1',
    clauses: [{ id: 'a', event: 'demo.ready', serverId: 'demo', where: [] }],
    pattern: { root: { kind: 'event', ref: 'a' } },
    withinMs: 60000,
    target: { runtime: 'fixture', kind: 'task', id: 'task-1' },
  });
  const state = { status: 'active', owner: { type: 'user', principal_id: 'owner-1' } };
  const base = { receiptId: 'receipt-1', definition, state };
  for (const operation of ['create', 'update', 'pause', 'resume', 'delete']) {
    const expectedStatus = operation === 'pause' ? 'paused' :
      operation === 'delete' ? 'deleted' : 'active';
    const candidate = {
      ...base, action: operation,
      state: { ...state, status: expectedStatus },
      ...(operation === 'update' ? {
        previous: { definition, state: { ...state, status: 'completed' } },
      } : {}),
    };
    assert.equal(validateOperationOutput('stdio', operation, candidate), candidate);
    assert.equal(outputJsonSchema('stdio', operation).properties.action.const, operation);
    for (const bad of [
      { ...candidate, action: 'delete-other' },
      { ...candidate, receiptId: '' },
      { ...candidate, state: { owner: state.owner } },
      { ...candidate, state: { ...state, status: expectedStatus + '-wrong' } },
      { ...candidate, definition: { triggerId: 'invalid' } },
      { ...candidate, definition: { ...definition, protocolVersion: undefined } },
      { ...candidate, definition: { ...definition, clauses: definition.clauses.map(
        c => ({ ...c, arguments: undefined })
      ) } },
      ...(operation === 'update' ? [
        { ...candidate, previous: undefined },
        { ...candidate, previous: { definition, state } },
      ] : []),
    ]) {
      assert.throws(
        () => validateOperationOutput('stdio', operation, bad),
        e => e.code === 'EI_OUTPUT_CONTRACT_INVALID',
        operation,
      );
    }
    assert.throws(() => outputValidator('embedded', operation),
      /Unmodeled EI output projection/);
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
