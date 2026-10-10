import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import {
  EMBEDDED_OPERATION_REGISTRY,
  createEventIntelligenceAgentTools,
} from '../scripts/embedded-host-kit.mjs';
import { OPERATION_MANIFEST } from '../scripts/lib/operation-manifest.mjs';
import {
  EMBEDDED_INPUT_VALIDATORS,
  EMBEDDED_INPUT_JSON_SCHEMAS,
} from '../scripts/lib/embedded-operation-schemas.mjs';

const keys = ['sources','create','list','inspect','pause','resume','delete','update'];
const input = {
  events: [{
    event: 'supplier.invoice.submitted',
    serverId: 'erp',
    where: [{ path:'amount', op:'gt', value:1000 }],
  }],
  instruction: 'Continue only after matching event.',
};
const cases = Object.freeze({
  sources: { valid: {}, invalid: { bypass:true } },
  create: { valid: input, invalid: { ...input, events: [] } },
  list: { valid: { limit:200 }, invalid: { limit:201 } },
  inspect: { valid: { trigger_id:'t' }, invalid: { version:'1' } },
  pause: { valid: { trigger_id:'t' }, invalid: { trigger_id:'' } },
  resume: { valid: { trigger_id:'t' }, invalid: { trigger_id:'' } },
  delete: { valid: { trigger_id:'t' }, invalid: { trigger_id:'' } },
  update: {
    valid: { ...input, trigger_id:'t' },
    invalid: { ...input, trigger_id:'t', events: Array.from({ length:33 }, () => ({event:'x'})) },
  },
});

test('all eight embedded schemas are generated from their execution validators', () => {
  assert.deepEqual(Object.keys(EMBEDDED_INPUT_VALIDATORS).sort(), keys.sort());
  assert.deepEqual(Object.keys(EMBEDDED_OPERATION_REGISTRY).sort(), keys.sort());
  for(const key of keys){
    const actual = EMBEDDED_OPERATION_REGISTRY[key];
    const expected = z.toJSONSchema(EMBEDDED_INPUT_VALIDATORS[key], {io:'input'});
    assert.deepEqual(actual.inputSchema, expected, key);
    assert.deepEqual(EMBEDDED_INPUT_JSON_SCHEMAS[key], expected, key);
    assert.equal(actual.capability, OPERATION_MANIFEST[key].capability);
    assert.equal(actual.inputSchema.additionalProperties, false, key);
    assert.equal(Object.isFrozen(actual.inputSchema), true, key);
    assert.equal(
      EMBEDDED_INPUT_VALIDATORS[key].safeParse(cases[key].valid).success,
      true,key+' valid fixture',
    );
    assert.equal(
      EMBEDDED_INPUT_VALIDATORS[key].safeParse(cases[key].invalid).success,
      false,key+' invalid fixture',
    );
  }
});

test('nested advertised embedded create/update inputs include Zod constraints', () => {
  for (const key of ['create','update']) {
    const schema = EMBEDDED_OPERATION_REGISTRY[key].inputSchema;
    assert.equal(schema.properties.events.minItems, 1);
    assert.equal(schema.properties.events.maxItems, 32);
    assert.equal(schema.properties.instruction.minLength, 1);
    assert.equal(schema.properties.instruction.maxLength, 4000);
    assert.equal(schema.properties.events.items.additionalProperties, false);
    assert.deepEqual(schema.properties.events.items.required, ['event']);
    assert.equal(schema.properties.events.items.properties.where.maxItems, 32);
    assert.ok(schema.required.includes('events'));
    assert.ok(schema.required.includes('instruction'));
  }
  assert.deepEqual(
    EMBEDDED_OPERATION_REGISTRY.create.inputSchema.properties.expires_at.format,
    'date-time',
  );
});

test('lifecycle schemas are canonical shared objects and reject undeclared authority fields',()=>{
  const pause = EMBEDDED_OPERATION_REGISTRY.pause.inputSchema;
  assert.equal(pause,EMBEDDED_OPERATION_REGISTRY.resume.inputSchema);
  assert.equal(pause,EMBEDDED_OPERATION_REGISTRY.delete.inputSchema);
  for(const key of ['pause','resume','delete']){
    assert.equal(EMBEDDED_INPUT_VALIDATORS[key].safeParse({
      trigger_id:'t', owner:'someone-else', tenant_id:'other',
    }).success,false);
  }
});

test('the actual embedded source-list execution rejects undisclosed arguments', async () => {
  let sourceReads = 0;
  let resolves = 0;
  const tools = createEventIntelligenceAgentTools({
    host: {
      get eventSources() {
        sourceReads++;
        return [{connectionId:'erp',eventName:'item.changed'}];
      },
    },
    resolveContext: () => {
      resolves++;
      return {
        actor:{type:'agent',principal_id:'agent-1'},
        owner:{type:'user',principal_id:'user-1'},
      };
    },
    control: () => ({action:'return',result:{ok:false}}),
  });
  const list = tools.find(item => item.name === 'event_sources_list');
  assert.ok(list);
  const invalid = await list.execute({bypass:true},{});
  assert.equal(invalid.ok,false);
  assert.equal(sourceReads,0);
  assert.equal(resolves,0);
  const valid = await list.execute({},{});
  assert.equal(valid.ok,true);
  assert.equal(sourceReads,1);
  assert.equal(resolves,1);
});
