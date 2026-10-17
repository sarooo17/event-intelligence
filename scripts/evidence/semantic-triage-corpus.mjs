import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { PatternAstV2DefinitionSchema, evaluatePatternV2 } from '../../dist/src/intelligenceProtocol/index.js';
import {
  SYNTHETIC_TRIAGE_CORPUS_VERSION,
  SYNTHETIC_TRIAGE_CASES,
} from './semantic-triage-fixtures.mjs';

const FIXED_TIME = '2026-10-14T15:00:00.000Z';

function pattern(threshold) {
  return PatternAstV2DefinitionSchema.parse({
    version:'2',
    root:{
      kind:'semantic',id:'importance',
      refs:['issue'],instruction:'Classify an important issue change',
      input:['issue.title'],
      matchThreshold:threshold,rejectThreshold:0.2,uncertain:'reject',
      execution:{cache:false,timeoutMs:1000,onUnavailable:'reject'},
      child:{kind:'event',ref:'issue'},
    },
    partitionBy:[],
    selection:{overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:1},
    execution:{
      maxCandidates:4,maxSemanticEvaluations:1,maxBufferedEvents:4,
    },
  });
}

function occurrence(item, index) {
  return {
    clauseId:item.eligible?'issue':'noise',
    traceId:'synthetic-triage:'+item.id,
    sourceEventId:'synthetic-triage:'+item.id,
    eventName:item.eligible?'github.issue.updated':'github.issue.reaction',
    serverId:'synthetic-events',
    provider:'synthetic-only',
    subscriptionArguments:{},
    occurredAt:new Date(Date.parse(FIXED_TIME)+index*1000).toISOString(),
    data:{title:item.title},
  };
}

function metrics(cases) {
  const summary={truePositive:0,falsePositive:0,trueNegative:0,falseNegative:0};
  for(const c of cases) {
    const key = c.important
      ? c.notify ? 'truePositive':'falseNegative'
      : c.notify ? 'falsePositive':'trueNegative';
    summary[key]++;
  }
  const precisionDenominator=summary.truePositive+summary.falsePositive;
  const recallDenominator=summary.truePositive+summary.falseNegative;
  return {
    ...summary,
    precision:precisionDenominator?summary.truePositive/precisionDenominator:null,
    recall:recallDenominator?summary.truePositive/recallDenominator:null,
  };
}

/** Deterministic *mock evaluator* quality evidence against manually authored
 * synthetic labels. No network or model call; no production costs implied. */
export async function runSyntheticTriageCorpus() {
  const profiles=[];
  for(const [profile,threshold] of [
    ['high-precision',0.9],
    ['balanced',0.6],
  ]) {
    const records=[];
    let calls=0;
    let estimatedFixtureTokens=0;
    for(const [index,item] of SYNTHETIC_TRIAGE_CASES.entries()){
      const evaluator={
        cacheIdentity:'synthetic-score-fixture:v1',
        async evaluate() {
          calls++;
          estimatedFixtureTokens+=item.tokens;
          return {
            evaluator:'synthetic-score-fixture:v1',
            probability:item.probability,
          };
        },
      };
      const outcome=await evaluatePatternV2({
        definition:pattern(threshold),
        events:[occurrence(item,index)],
        evaluator,
        now:new Date('2026-10-14T15:05:00.000Z'),
      });
      if(outcome.truncated || outcome.pending.length) {
        throw new Error('Invalid synthetic conformance classification: '+item.id);
      }
      records.push({
        id:item.id,
        category:item.category,
        important:item.important,
        notify:outcome.matches.length>0,
        semanticEvaluations:outcome.semanticEvaluations,
      });
      if(outcome.semanticEvaluations !== Number(item.eligible)) {
        throw new Error('Deterministic prefilter budget violated: '+item.id);
      }
    }
    const quality=metrics(records);
    profiles.push({
      profile,threshold,
      sampleSize:records.length,
      calls,
      estimatedFixtureTokens,
      // This is a scenario token estimate, not provider usage/billing.
      estimatedTokensPerNotification: quality.truePositive+quality.falsePositive
        ? estimatedFixtureTokens/(quality.truePositive+quality.falsePositive):null,
      quality,
      records,
    });
  }
  return {
    schema:SYNTHETIC_TRIAGE_CORPUS_VERSION,
    fixedTime:FIXED_TIME,
    evaluator:'scripted, no model/provider network',
    labels:'manually authored fictional expected importance; not model ground truth',
    costType:'per-fixture assumed tokens, not measured provider usage or actual USD',
    cases:SYNTHETIC_TRIAGE_CASES.length,
    profiles,
    caveat:'Synthetic Pattern v2 evaluation only; no real user labels, no predictive calibration, no persistent cross-event context, dedup, or 1.0 security/quality certification.',
  };
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const result=await runSyntheticTriageCorpus();
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
