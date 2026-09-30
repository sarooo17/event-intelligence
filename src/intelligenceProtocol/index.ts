export {
  PATTERN_AST_VERSION,
  PatternValueSelectorSchema,
  PatternArithmeticValueSchema,
  PatternCompareOperatorSchema,
  AggregateFunctionSchema,
  PatternWindowSchema,
  PatternNodeV2Schema,
  PatternPartitionDimensionSchema,
  PatternAfterMatchSchema,
  PatternSelectionSchema,
  PatternExecutionPolicySchema,
  PatternMeasureSchema,
  PatternAstV2DefinitionSchema,
  collectPatternDurationsMs,
  collectGuaranteedPatternBindings,
  collectPatternMeasureRefs,
  collectPatternRefs,
} from './patternV2Schemas.js';

export type {
  PatternValueSelector,
  PatternArithmeticValue,
  PatternWindow,
  PatternNodeV2,
  PatternAfterMatch,
  PatternAstV2Definition,
  PatternMeasure,
} from './patternV2Schemas.js';

export {
  evaluatePatternV2,
  evaluatePatternAggregate,
  evaluatePatternMeasure,
  patternV2CandidateSignature,
} from '../patternV2/evaluator.js';

export type {
  PatternV2Candidate,
  PatternV2Evaluation,
  PatternV2SemanticCache,
  PatternV2SemanticDecision,
  PatternV2SemanticTrace,
} from '../patternV2/evaluator.js';

export {
  TRIGGER_LANGUAGE_VERSION,
  PREDICATE_OPERATOR,
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
  McpEventOccurrenceSchema,
  WakeRecordSchema,
  LifecycleStateSchema,
  AuditKindSchema,
  AuditRecordSchema,
  parseWakeRecord,
  parseAuditRecord,
} from './schemas.js';

export type {
  RuntimeTarget,
  McpEventOccurrence,
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
  COMPOSITE_TRIGGER_PROTOCOL_VERSION,
  COMPOSITE_TRIGGER_SCHEMA_VERSION,
  StructuredPredicateSchema,
  TriggerClauseSchema,
  ContinuationContextPolicySchema,
  ContinuationContractSchema,
  EventTimePolicySchema,
  DerivedEventProjectionSchema,
  DerivedEventDefinitionSchema,
  DerivedEventEvidenceRefSchema,
  DerivedEventRecordSchema,
  CompositeTriggerDefinitionSchema,
  CorrelatableEventSchema,
  TriggerSourceEventSchema,
  PatternSemanticDecisionSchema,
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
  PatternSemanticDecision,
} from './triggerSchemas.js';


export {
  TriggerPlanEventSchema,
  TriggerPlanInputSchema,
  parseTriggerPlanInput,
} from './triggerPlanSchemas.js';

export type {
  TriggerPlanEvent,
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
