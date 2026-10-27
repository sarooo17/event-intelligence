import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createEventIntelligence} from '../embedded-host-kit.mjs';
import {runLocalHostV3Matrix} from '../../conformance/host-v3-matrix.mjs';

export function countLines(value) {
  if(typeof value!=='string') throw TypeError('source must be text');
  if(!value) return {physical:0,nonblank:0};
  const lines=value.replace(/\r\n/g,'\n').split('\n');
  if(lines.at(-1)==='')lines.pop();
  return {physical:lines.length,nonblank:lines.filter(x=>x.trim()).length};
}
export function compare(oldText,newText){
  const baseline=countLines(oldText),candidate=countLines(newText);
  return {baseline,candidate,delta:{
    physical:candidate.physical-baseline.physical,
    nonblank:candidate.nonblank-baseline.nonblank,
  }};
}
function host(){return {
  eventSources:[],runtime:{},
  async refreshMcpRegistry(){return[];},
  async mcpStatus(){return[];},
  async close(){},
};}
export async function measureSetup(tools=false,samples=5){
  if(!Number.isInteger(samples)||samples<1||samples>30)throw RangeError('invalid samples');
  const results=[];
  for(let i=0;i<samples;i++){
    const before=performance.now();
    const ei=await createEventIntelligence({
      runtime:{
        deliver(){return{runtimeReceiptId:'test-fixture-receipt'}},
        ...(tools?{
          resolveContext(){return{
            target:{runtime:'fixture',kind:'job',id:'job-1'},
            actor:{type:'user',principal_id:'fixture'},
            owner:{type:'user',principal_id:'fixture'},
          }},
          control(){return{action:'return',result:{ok:false}}},
        }:{}),
      },
      createHost:async()=>host(),
    });
    await ei.close();
    results.push(performance.now()-before);
  }
  const sorted=results.toSorted((a,b)=>a-b),round=n=>Math.round(n*1000)/1000;
  return{
    profile:tools?'managed-tool-fixture':'headless-fixture',
    samples,minMs:round(sorted[0]),
    medianMs:round(sorted[Math.floor((samples-1)/2)]),
    maxMs:round(sorted.at(-1)),
    measured:'facade+stub-host initialization and close',
    humanIntegrationTimeMeasured:false,remoteHostLatencyMeasured:false,
  };
}
export async function report(paths,pins){
  const baselineHost=readFileSync(resolve(paths.baselineHost),'utf8');
  const candidateHost=readFileSync(resolve(paths.candidateHost),'utf8');
  const baselineCore=readFileSync(resolve(paths.baselineCore),'utf8');
  const candidateCore=readFileSync(resolve(paths.candidateCore),'utf8');
  const consumer=compare(baselineHost,candidateHost);
  const embedded=compare(baselineCore,candidateCore);
  const matrix=await runLocalHostV3Matrix();
  assert.equal(matrix.complete,true);
  assert.equal(matrix.independentExternalHostVerified,false);
  assert.equal(matrix.fixtures.length,3);
  const [headless,managed]=await Promise.all([measureSetup(false),measureSetup(true)]);
  return{
    schema:'event-intelligence.host-ergonomics-report.v1',
    status:'bounded-verified',pins,
    fixtures:matrix.fixtures.map(f=>({
      id:f.id,fixtureAuthorship:f.authorship,
      integrationBoundary:f.integrationBoundary,
      executionBoundary:f.executionBoundary,
      passed:f.v3Report.passed,
      total:f.v3Report.summary.total,
      successful:f.v3Report.summary.passed,
    })),
    independentExternalHostVerified:false,
    codeCost:{
      wholeMuffinAdapter:consumer,existingEIEmbeddedCore:embedded,
      comparedSourceSlices:{
        baselinePhysical:consumer.baseline.physical+embedded.baseline.physical,
        candidatePhysical:consumer.candidate.physical+embedded.candidate.physical,
        deltaPhysical:consumer.delta.physical+embedded.delta.physical,
      },
      extractedGenericAdapterKitModules:0,
      completeSystemSourceLinesMeasured:false,
      majorAdapterSimplificationProven:false,
    },
    setup:{headless,managed},
    limitations:[
      'EI core module changes include features unrelated to host ergonomics',
      'Only two source files compared, not entire EI and consumer dependency graph',
      'No developer integration time, deployed provider network or production SLO measured',
      'Fixture-authored conformance is not independent third-party adoption',
    ],
  };
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=Object.fromEntries(process.argv.slice(2).reduce((pairs,v,i,a)=>{
      if(i%2===0){if(!v.startsWith('--')||!a[i+1])throw Error('expected --key value');pairs.push([v.slice(2),a[i+1]]);}
      return pairs;
    },[]));
    const keys=['baseline-host','candidate-host','baseline-core','candidate-core'];
    if(keys.some(k=>!args[k]))throw Error('four file paths required');
    const result=await report({
      baselineHost:args['baseline-host'],candidateHost:args['candidate-host'],
      baselineCore:args['baseline-core'],candidateCore:args['candidate-core'],
    },{
      muffinBaseline:'a6e6bfaec5d6847b1985980fe6f524ef0193dc02',
      muffinCandidate:'5f68a51bd99568bd8268d3d5ab9a1947b81d041b',
      eiBaseline:'v0.11.0',eiCandidate:process.env.GITHUB_SHA??'local-working-tree',
    });
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  }catch(error){console.error('HOST_ERGONOMICS_REPORT_FAILED:',error);process.exitCode=1;}
}
