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
  ContinuationContextPolicySchema,
  ContinuationContractSchema,
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
  DerivedEventDefinition,
  DerivedEventRecord,
  CompositeTriggerDefinition,
  CorrelatableEvent,
  TriggerSourceEvent,
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
