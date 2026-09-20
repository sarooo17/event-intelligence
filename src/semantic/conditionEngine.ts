import type {
  SemanticBooleanCondition,
  SemanticDecision,
  SemanticEvaluator,
} from './types.js';

function getByPath(source: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = source;

  for (const part of parts) {
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current)
    ) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

export function projectSemanticInput(
  source: Record<string, unknown>,
  paths: string[],
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};

  for (const path of paths) {
    projected[path] = getByPath(source, path);
  }

  return projected;
}

export class SemanticConditionEngine {
  constructor(private readonly evaluator: SemanticEvaluator) {}

  async evaluate(
    source: Record<string, unknown>,
    condition: SemanticBooleanCondition,
  ): Promise<SemanticDecision> {
    const result = await this.evaluator.evaluate({
      instruction: condition.instruction,
      input: projectSemanticInput(source, condition.input),
    });

    if (
      !Number.isFinite(result.probability) ||
      result.probability < 0 ||
      result.probability > 1
    ) {
      throw new Error('Semantic evaluator probability must be between 0 and 1');
    }

    const shared = {
      probability: result.probability,
      evaluator: result.evaluator,
      condition,
      ...(result.metadata ? { metadata: result.metadata } : {}),
    };

    if (result.probability >= condition.matchThreshold) {
      return {
        outcome: 'match',
        matched: true,
        shouldEscalate: false,
        ...shared,
      };
    }

    if (result.probability <= condition.rejectThreshold) {
      return {
        outcome: 'reject',
        matched: false,
        shouldEscalate: false,
        ...shared,
      };
    }

    return {
      outcome: 'uncertain',
      matched: condition.uncertain === 'match',
      shouldEscalate: condition.uncertain === 'escalate',
      ...shared,
    };
  }
}
