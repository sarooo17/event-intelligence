import type {
  SemanticEvaluation,
  SemanticEvaluationRequest,
  SemanticEvaluator,
} from './types.js';

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface TypeSafeJevEvaluatorOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchFn?: FetchLike;
  maxRetries?: number;
  retryBaseMs?: number;
}

interface JevNoulResponse {
  model: string;
  answers: {
    match: {
      type: 'noul';
      noul: number;
    };
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cost?: number;
  };
}

interface JevHttpResponse {
  body: JevNoulResponse;
  httpStatus: number;
  requestId?: string;
}

export class TypeSafeJevEvaluator implements SemanticEvaluator {
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(private readonly options: TypeSafeJevEvaluatorOptions) {
    if (!options.apiKey) {
      throw new Error('TypeSafe API key is required');
    }

    this.model = options.model ?? 'jev-latest';
    this.baseUrl = options.baseUrl ?? 'https://api.typesafe.ai/v1/systemone';
    this.fetchFn = options.fetchFn ?? fetch;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseMs = options.retryBaseMs ?? 100;
  }

  static fromEnvironment(
    env: Record<string, string | undefined>,
  ): TypeSafeJevEvaluator {
    const apiKey = env.TYPESAFE_API_KEY;
    if (!apiKey) {
      throw new Error('TYPESAFE_API_KEY is required');
    }

    return new TypeSafeJevEvaluator({
      apiKey,
      model: env.TYPESAFE_MODEL ?? 'jev-latest',
    });
  }

  async evaluate(
    request: SemanticEvaluationRequest,
  ): Promise<SemanticEvaluation> {
    const payload = {
      state: request.input,
      model: this.model,
      questions: {
        match: {
          type: 'noul',
          instructions: request.instruction,
        },
      },
    };

    const response = await this.requestWithRetry(payload);
    const answer = response.body.answers?.match;

    if (
      !answer ||
      answer.type !== 'noul' ||
      !Number.isFinite(answer.noul) ||
      answer.noul < 0 ||
      answer.noul > 1
    ) {
      throw new Error('Invalid Jev noul response');
    }

    return {
      evaluator: `typesafe/${response.body.model}`,
      probability: answer.noul,
      metadata: {
        requestedModel: this.model,
        resolvedModel: response.body.model,
        inputTokens: response.body.usage?.input_tokens,
        outputTokens: response.body.usage?.output_tokens,
        cost: response.body.usage?.cost,
        httpStatus: response.httpStatus,
        requestId: response.requestId,
      },
    };
  }

  private async requestWithRetry(
    payload: Record<string, unknown>,
  ): Promise<JevHttpResponse> {
    let attempt = 0;

    while (true) {
      const response = await this.fetchFn(this.baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const body = (await response.json()) as JevNoulResponse;
        const requestId =
          response.headers.get('x-request-id') ??
          response.headers.get('request-id') ??
          response.headers.get('x-amzn-requestid') ??
          undefined;

        return {
          body,
          httpStatus: response.status,
          requestId,
        };
      }

      const retryable = response.status === 429 || response.status === 529;
      if (!retryable || attempt >= this.maxRetries) {
        throw new Error(
          `TypeSafe Jev request failed with HTTP ${response.status}`,
        );
      }

      const waitMs = this.retryBaseMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      attempt += 1;
    }
  }
}
