export {
  PATTERN_AST_VERSION,
  PatternValueSelectorSchema,
  PatternArithmeticValueSchema,
  PatternCompareOperatorSchema,
  AggregateFunctionSchema,
  PatternWindowSchema,
  PatternNodeV2Schema,
  PatternPartitionDimensionSchema,
  PatternSelectionSchema,
  PatternExecutionPolicySchema,
  PatternMeasureSchema,
  PatternAstV2DefinitionSchema,
  collectPatternDurationsMs,
  collectPatternMeasureRefs,
  collectPatternRefs,
} from './patternV2Schemas.js';

export type {
  PatternValueSelector,
  PatternArithmeticValue,
  PatternWindow,
  PatternNodeV2,
  PatternAstV2Definition,
  PatternMeasure,
} from './patternV2Schemas.js';

export {
  compileLegacyTriggerToPatternV2,
} from '../patternV2/legacyCompiler.js';

export {
  evaluatePatternV2,
  evaluatePatternAggregate,
  evaluatePatternMeasure,
  patternV2CandidateSignature,
} from '../patternV2/evaluator.js';

export type {
  PatternV2Candidate,
  PatternV2Evaluation,
  PatternV2SemanticDecision,
  PatternV2SemanticTrace,
} from '../patternV2/evaluator.js';

export {
  TRIGGER_LANGUAGE_VERSION,
  PREDICATE_OPERATOR,
  COMPOSITION_OPERATOR,
  TEMPORAL_OPERATOR,
  TRIGGER_LANGUAGE_CATALOG,
  describeTriggerLanguage,
} from './operatorRegistry.js';

export type {
  TriggerLanguageCategory,
} from './operatorRegistry.js';

export {
  EVENT_INTELLIGENCE_PROTOCOL,
  EVENT_INTELLIGENCE_PROTOCOL_VERSION,
  EVENT_INTELLIGENCE_SCHEMA_VERSION,
  EVENT_INTELLIGENCE_COMPATIBILITY,
} from './version.js';

export {
  RuntimeTargetSchema,
  EventSourceSchema,
  EventLineageSchema,
  McpEventOccurrenceSchema,
  SemanticConditionWireSchema,
  EventIngestRequestSchema,
  SemanticDecisionRecordSchema,
  WakeRecordSchema,
  LifecycleStateSchema,
  AuditKindSchema,
  AuditRecordSchema,
  parseEventIngestRequest,
  parseEventLineage,
  parseSemanticDecisionRecord,
  parseWakeRecord,
  parseAuditRecord,
} from './schemas.js';

export type {
  RuntimeTarget,
  McpEventOccurrence,
  SemanticConditionWire,
  EventIngestRequest,
  EventLineage,
  SemanticDecisionRecord,
  WakeRecord,
  LifecycleState,
  AuditRecord,
} from './schemas.js';

export {
  canTransition,
  assertTransition,
  allowedTransitions,
} from './lifecycle.js';

export {
  canonicalJson,
  sha256Hex,
} from './canonical.js';

export {
  AuditChain,
} from './audit.js';

export type {
  AppendAuditInput,
} from './audit.js';

export {
  mapMcpEventToLineage,
} from './mapper.js';

export type {
  MapMcpEventInput,
} from './mapper.js';

export {
  assertDecisionLineage,
  assertWakeLineage,
} from './invariants.js';


export {
  COMPOSITE_TRIGGER_PROTOCOL_VERSION,
  COMPOSITE_TRIGGER_SCHEMA_VERSION,
  StructuredPredicateSchema,
  TriggerClauseSchema,
  TemporalConditionSchema,
  ContinuationContextPolicySchema,
  ContinuationContractSchema,
  EventTimePolicySchema,
  DerivedEventProjectionSchema,
  DerivedEventDefinitionSchema,
  DerivedEventEvidenceRefSchema,
  DerivedEventRecordSchema,
  DeterministicCorrelationSchema,
  SemanticCorrelationSchema,
  CompositeTriggerDefinitionSchema,
  CorrelatableEventSchema,
  TriggerSourceEventSchema,
  CompositeCorrelationDecisionSchema,
  TriggerMatchStatusSchema,
  PatternMatchStateSchema,
  TriggerMatchRecordSchema,
  parseCompositeTriggerDefinition,
  parseCorrelatableEvent,
  parseTriggerMatchRecord,
  parseDerivedEventRecord,
} from './triggerSchemas.js';

export type {
  StructuredPredicate,
  TriggerClause,
  TemporalCondition,
  ContinuationContextPolicy,
  ContinuationContract,
  EventTimePolicy,
  DerivedEventDefinition,
  DerivedEventRecord,
  CompositeTriggerDefinition,
  CorrelatableEvent,
  TriggerSourceEvent,
  PatternMatchState,
  TriggerMatchRecord,
  CompositeCorrelationDecision,
} from './triggerSchemas.js';


export {
  TriggerPlanEventSchema,
  TriggerPlanMatchSchema,
  TriggerPlanInputSchema,
  parseTriggerPlanInput,
} from './triggerPlanSchemas.js';

export type {
  TriggerPlanEvent,
  TriggerPlanMatch,
  TriggerPlanInput,
} from './triggerPlanSchemas.js';


export {
  ActivationEvidenceSchema,
  ActivationEnvelopeSchema,
  parseActivationEnvelope,
} from './activationSchemas.js';

export type {
  ActivationEvidence,
  ActivationEnvelope,
} from './activationSchemas.js';
