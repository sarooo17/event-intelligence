import assert from 'node:assert/strict';
import test from 'node:test';
import {bindEmbeddedRuntimeIntegration} from '../scripts/embedded-host-kit.mjs';

function tools() {
  return [
    {name:'first',capability:{id:'capability.read'},execute:async()=>({ok:true})},
    {name:'second',capability:{id:'capability.write'},execute:async()=>({ok:true})},
  ];
}
const integration=()=>({tools:tools(),close:async()=>{}});

test('failing a later native adaptation exposes zero earlier tools and no close hook',()=>{
  const effects=[];
  assert.throws(()=>bindEmbeddedRuntimeIntegration(integration(),{
    capabilityIds:['capability.read','capability.write'],
    adapt(portable){
      effects.push('adapt:'+portable.name);
      if(portable.name==='second')throw new Error('unsupported second ABI');
      return {native:portable.name};
    },
    register(hostTool){effects.push('register:'+hostTool.native)},
    onClose(){effects.push('onClose')},
  }),/unsupported second ABI/);
  assert.deepEqual(effects,['adapt:first','adapt:second']);
});

test('successful binding adapts all allowlisted tools before first registration',()=>{
  const events=[];
  const tools=bindEmbeddedRuntimeIntegration(integration(),{
    capabilityIds:['capability.read','capability.write'],
    adapt(portable){events.push('adapt:'+portable.name);return {native:portable.name}},
    register(hostTool,portable){
      events.push('register:'+portable.name);
      assert.equal(hostTool.native,portable.name);
    },
    onClose(hook){
      events.push('onClose');
      assert.equal(typeof hook,'function');
    },
  });
  assert.equal(Object.isFrozen(tools),true);
  assert.deepEqual(tools,[{native:'first'},{native:'second'}]);
  assert.deepEqual(events,[
    'adapt:first','adapt:second','register:first','register:second','onClose',
  ]);
});

test('capability allowlist rejects unknown ID before adaptation or host effects',()=>{
  let called=0;
  assert.throws(()=>bindEmbeddedRuntimeIntegration(integration(),{
    capabilityIds:['capability.read','new.unknown'],
    adapt(){called++;return{}},
    register(){called++},
  }),/unknown EI capability/);
  assert.equal(called,0);
});

test('host registration failure propagates; EI does not invent transactional rollback',()=>{
  const events=[];
  assert.throws(()=>bindEmbeddedRuntimeIntegration(integration(),{
    adapt(portable){events.push('adapt:'+portable.name);return{native:portable.name}},
    register(host){
      events.push('register:'+host.native);
      if(host.native==='second')throw Error('host registration denied');
    },
    onClose(){events.push('onClose')},
  }),/host registration denied/);
  assert.deepEqual(events,[
    'adapt:first','adapt:second','register:first','register:second',
  ]);
  // A host that needs rollback MUST supply its own staged registry semantics.
});
