export type UncertainPolicy = 'escalate' | 'reject' | 'match';

export interface SemanticBooleanCondition {
  type: 'semantic_boolean';
  instruction: string;
  input: string[];
  matchThreshold: number;
  rejectThreshold: number;
  uncertain: UncertainPolicy;
}

export interface SemanticEvaluationRequest {
  instruction: string;
  input: Record<string, unknown>;
}

export interface SemanticEvaluation {
  evaluator: string;
  probability: number;
  metadata?: Record<string, unknown>;
}

export interface SemanticEvaluator {
  /**
   * Stable identity for durable semantic-decision caching. It must change when
   * evaluator semantics/model configuration changes. Evaluators that omit it
   * remain eligible only for evaluation-pass caching.
   */
  readonly cacheIdentity?: string;
  /** Optional cooperative cancellation; host provider adapters must honor
   * it to stop remote work on an EI deadline. Old one-argument adapters
   * remain source-compatible but may continue billable work after timeout. */
  evaluate(request: SemanticEvaluationRequest,
    options?: { signal?: AbortSignal }): Promise<SemanticEvaluation>;
}

export type SemanticOutcome = 'match' | 'reject' | 'uncertain';

export interface SemanticDecision {
  outcome: SemanticOutcome;
  matched: boolean;
  shouldEscalate: boolean;
  probability: number;
  evaluator: string;
  condition: SemanticBooleanCondition;
  metadata?: Record<string, unknown>;
}
