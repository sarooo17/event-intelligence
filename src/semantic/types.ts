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
  evaluate(request: SemanticEvaluationRequest): Promise<SemanticEvaluation>;
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
