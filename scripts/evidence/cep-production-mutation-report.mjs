import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { runMutationCorpus } from './cep-production-mutation-harness.mjs';

const args=process.argv.slice(2);
assert.ok(args.length===0 || (args.length===2 &&
  args[0]==='--out' && args[1] && !args[1].startsWith('-')),
  'usage: node scripts/evidence/cep-production-mutation-report.mjs [--out FILE]');
const report=await runMutationCorpus();
assert.equal(report.killedMutants,report.totalMutants,
  'release mutation gate must reject survivors');
const json=JSON.stringify(report,null,2)+'\n';
if(args.length===2){
  await writeFile(args[1],json,{flag:'w'});
  console.log('CEP production mutation evidence written:',args[1],
    '('+report.killedMutants+'/'+report.totalMutants+' mutants killed)');
}else process.stdout.write(json);
