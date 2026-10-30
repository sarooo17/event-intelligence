#!/usr/bin/env node
// Dedicated opt-in Railway runner, NOT a generic EI core provider dependency.
// Requires an isolated API project/key; NEVER log credentials or prompts.
import pg from 'pg';
import {PostgresEventStore} from '../lib/postgres-event-store.mjs';
import {
  createOpenAIResponsesValidationTransport,runOpenAIResponsesValidationCase,
} from './openai-responses-provider.mjs';

const req=['DATABASE_URL','OPENAI_API_KEY','EI_OPENAI_TEST_BATCH',
  'EI_OPENAI_TEST_RESERVATION'];
if(process.env.EI_CONFIRM_LIVE_OPENAI_TEST!=='YES'||
  req.some(key=>typeof process.env[key]!=='string'||!process.env[key].trim()))
  throw Error('EI_OPENAI_LIVE_TEST_DISABLED_OR_MISSING_KEYS');
const prefix=process.env.EI_OPENAI_TEST_TABLE_PREFIX??'ei_openai_validation';
if(!/^[a-z][a-z0-9_]{1,35}$/.test(prefix))
  throw Error('EI_OPENAI_TEST_TABLE_PREFIX_INVALID');
// Allow only one of two small, explicitly bounded output caps. A higher cap
// for a NEW run requires a NEW host-owned budget epoch and reservation ID,
// not a retry of an earlier possibly billed provider request.
const outputCap=Number(process.env.EI_OPENAI_MAX_OUTPUT_TOKENS??32);
if(![32,64].includes(outputCap))
  throw Error('EI_OPENAI_MAX_OUTPUT_TOKENS_INVALID');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,
  max:3,connectionTimeoutMillis:5000,statement_timeout:15000});
try{
  const store=new PostgresEventStore({
    pool,dispatchPoolIdentity:pool,
    tablePrefix:prefix,
    scopeId:process.env.EI_OPENAI_TEST_SCOPE??'ei.validation.openai',
  });
  await store.init();
  const transport=createOpenAIResponsesValidationTransport({
    apiKey:process.env.OPENAI_API_KEY,requestTimeoutMs:15000,
  });
  const result=await runOpenAIResponsesValidationCase({
    store,transport,batchId:process.env.EI_OPENAI_TEST_BATCH,
    reservationId:process.env.EI_OPENAI_TEST_RESERVATION,
    budgetEpoch:process.env.EI_OPENAI_TEST_EPOCH??'provider-validation-1',
    maxOutputTokens:outputCap,
  });
  // Safe metadata only. A result never contains prompt or raw response ID.
  console.log(JSON.stringify({
    contract:'ei.openai-live-validation.v1',
    ...result,externalProvider:'openai',
    invoiceCertified:false,
    requiresAdminCostReconciliation:true,
    sourceIndependentProvider:true,
  }));
  if(!['usage_observed_billing_unknown','admission_denied',
    'input_preflight_refused'].includes(result.status))
    process.exitCode=2;
}finally{
  await pool.end();
}
