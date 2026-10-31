#!/usr/bin/env node
import {createStandaloneSource,serveStandaloneSource} from
  './standalone-mcp-source.mjs';
const required=name=>{
  const value=process.env[name];
  if(!value)throw new Error('Missing stand-alone source configuration: '+name);
  return value;
};
const source=await createStandaloneSource({
  logPath:required('EI_SOURCE_LOG_PATH'),
  privateKeyPem:required('EI_SOURCE_PRIVATE_KEY_PEM').replace(/\\n/g,'\n'),
  scopeId:required('EI_SOURCE_SCOPE_ID'),
  sourceKeyDigest:required('EI_SOURCE_KEY_DIGEST'),
  connectionId:required('EI_SOURCE_CONNECTION_ID'),
  serverId:required('EI_SOURCE_SERVER_ID'),
  eventName:required('EI_SOURCE_EVENT_NAME'),
  argumentsCanonical:process.env.EI_SOURCE_ARGUMENTS_CANONICAL??'{}',
});
const listening=await serveStandaloneSource({
  source,token:required('EI_SOURCE_CONTROL_TOKEN'),
  port:Number(process.env.PORT??'0'),
  host:process.env.EI_SOURCE_BIND_HOST??'127.0.0.1',
});
console.log(JSON.stringify({event:'ei_source_listening',
  port:listening.address.port,privateControl:true,
  policy:'monotonic-event-time-complete-through-v1'}));
async function exit(){
  try{await listening.close();await source.close();process.exitCode=0;}
  catch{process.exitCode=1;}
}
process.once('SIGTERM',()=>void exit());
process.once('SIGINT',()=>void exit());
