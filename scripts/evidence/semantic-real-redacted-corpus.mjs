import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {PatternAstV2DefinitionSchema,evaluatePatternV2}
  from '../../dist/src/intelligenceProtocol/index.js';
import {PUBLIC_PRIORITY_TRIAGE_CORPUS_VERSION,
  PUBLIC_PRIORITY_TRIAGE_SNAPSHOT,PUBLIC_PRIORITY_TRIAGE_CASES}
  from './semantic-real-redacted-fixtures.mjs';

const FIXED_TIME='2026-10-29T12:00:00.000Z';
// Benchmark pricing assumption only; NO provider billable token records.
const ASSUMED_MICROS_PER_MILLION_INPUT_TOKENS=3000000;
function lexicalPriorityProxyScore(title) {
  const text=String(title).toLowerCase();
  if(/\b(critical|cve|segfault|panic|expired|release.blocker|security)\b/i.test(text))return .95;
  if(/\b(fail(?:ing|ed|ures?)?|flak(?:e|ing|y)|regression|corrupt|blocks?|timeout)\b/i.test(text))return .76;
  if(/\b(test|bug|kubelet|pod|network|missing|resource)\b/i.test(text))return .59;
  return .28;
}
function pattern(threshold) {
  return PatternAstV2DefinitionSchema.parse({
    version:'2',root:{
      kind:'semantic',id:'k8s-priority',refs:['issue'],
      instruction:'Classify urgent priority of an issue update using redacted title',
      input:['issue.title'],matchThreshold:threshold,
      rejectThreshold:.15,uncertain:'reject',
      execution:{cache:false,timeoutMs:1000,onUnavailable:'reject'},
      child:{kind:'event',ref:'issue'},
    },partitionBy:[],
    selection:{overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:1},
    execution:{maxCandidates:4,maxSemanticEvaluations:1,maxBufferedEvents:4},
  });
}
function confusion(records) {
  const q={truePositive:0,falsePositive:0,trueNegative:0,falseNegative:0};
  for(const row of records) {
    if(row.importanceLabel && row.notify)q.truePositive++;
    else if(!row.importanceLabel && row.notify)q.falsePositive++;
    else if(row.importanceLabel)q.falseNegative++;
    else q.trueNegative++;
  }
  return {...q,
    precision:q.truePositive+q.falsePositive
      ? q.truePositive/(q.truePositive+q.falsePositive):null,
    recall:q.truePositive+q.falseNegative
      ? q.truePositive/(q.truePositive+q.falseNegative):null,
    falseNegativeRate:q.truePositive+q.falseNegative
      ? q.falseNegative/(q.truePositive+q.falseNegative):null};
}
export async function runPublicPriorityTriageCorpus() {
  const profiles=[];
  for(const [name,threshold] of [['high-precision',.85],['balanced',.55]]) {
    let calls=0,estimatedTokens=0;
    const records=[];
    for(const [index,item] of PUBLIC_PRIORITY_TRIAGE_CASES.entries()){
      const bytes=new TextEncoder().encode(item.redactedTitle).byteLength;
      // Conservative **scenario assumption**: prompt overhead + byte proxy.
      const upperInputTokens=64+Math.ceil(bytes/3);
      const evaluator={
        cacheIdentity:'k8s-priority-lexical-baseline:v1',
        async evaluate(source){
          calls++;
          estimatedTokens+=upperInputTokens;
          const input=source.issue?.title??'';
          if(input!==item.redactedTitle)throw Error('redaction/input separation failed');
          if(JSON.stringify(source).includes('priority/critical-urgent') ||
             JSON.stringify(source).includes('priority/backlog')) {
            throw Error('Leaked ground-truth label into model input');
          }
          return {evaluator:'k8s-priority-lexical-baseline:v1',
            probability:lexicalPriorityProxyScore(input)};
        },
      };
      const ev={
        clauseId:'issue',traceId:'public-priority:'+item.id,
        sourceEventId:'public-priority:'+item.id,
        eventName:'github.issue.updated',serverId:'public-github-issues',
        provider:'public-snapshot-no-network',subscriptionArguments:{},
        occurredAt:new Date(Date.parse(FIXED_TIME)+index*1000).toISOString(),
        data:{title:item.redactedTitle},
      };
      const out=await evaluatePatternV2({
        definition:pattern(threshold),events:[ev],evaluator,
        now:new Date('2026-10-29T13:00:00.000Z'),
      });
      if(out.truncated||out.pending.length||out.semanticEvaluations!==1) {
        throw Error('Real-redacted corpus incomplete: '+item.id);
      }
      records.push({id:item.id,sourceUrl:item.sourceUrl,
        capturedPriority:item.capturedPriority,importanceLabel:item.important,
        notify:out.matches.length===1,
        score:lexicalPriorityProxyScore(item.redactedTitle)});
    }
    const metrics=confusion(records);
    const notifications=metrics.truePositive+metrics.falsePositive;
    const costMicros=Math.ceil(
      estimatedTokens*ASSUMED_MICROS_PER_MILLION_INPUT_TOKENS/1000000);
    profiles.push({name,threshold,calls,
      estimatedInputTokenUpperProxy:estimatedTokens,
      assumedCostMicros:costMicros,
      assumedCostMicrosPerNotification:notifications
        ? costMicros/notifications:null,
      notifications,quality:metrics,records});
  }
  return {contract:'ei.semantic-public-priority-proxy.v1',
    corpusVersion:PUBLIC_PRIORITY_TRIAGE_CORPUS_VERSION,
    capturedDate:PUBLIC_PRIORITY_TRIAGE_SNAPSHOT,
    count:PUBLIC_PRIORITY_TRIAGE_CASES.length,
    positive:PUBLIC_PRIORITY_TRIAGE_CASES.filter(x=>x.important).length,
    negative:PUBLIC_PRIORITY_TRIAGE_CASES.filter(x=>!x.important).length,
    labelAuthority:'public Kubernetes maintainers priority labels, NOT human notification relevance',
    model:'deterministic keyword lexical baseline; NO LLM/provider',
    cost:'assumed upper-token scenario, no actual API billing',
    pricingAssumptionMicrosPerMillionInputTokens:
      ASSUMED_MICROS_PER_MILLION_INPUT_TOKENS,
    profiles,
    limitation:'Nonrandom, balanced public priority-label snapshot. Not temporal workload distribution, user-specific importance, measured LLM accuracy or provider spend.',
  };
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(await runPublicPriorityTriageCorpus(),null,2)+'\n');
}
