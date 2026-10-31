#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {verifyStandaloneOracle} from './standalone-mcp-source-oracle.mjs';
const reportPath=process.argv[2];
if(!reportPath)throw new Error('Expected one private fixture report JSON file path');
try{
  const inputs=JSON.parse(await readFile(reportPath,'utf8'));
  const result=await verifyStandaloneOracle(inputs);
  // No raw source events, bearer tokens or signatures in stdout evidence.
  console.log(JSON.stringify({status:'oracle-valid',
    eventCount:result.eventCount,sourceSequence:result.sourceSequence,
    sourceHeadHash:result.sourceHeadHash,revision:result.revision,
    thirdPartyCompletenessCertified:false}));
}catch(e){
  console.error(JSON.stringify({status:'oracle-rejected',code:e.code??'ORACLE_UNKNOWN'}));
  process.exitCode=1;
}
