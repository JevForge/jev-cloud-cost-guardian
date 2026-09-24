import { createGateway, experimental_evaluate as evaluate } from 'ai';
import type { JevProvider, JevProviderOptions, JevRawAnswer, CostEvaluationState } from './types.js';
import { answerFromEvaluateBody } from './http-evaluate.js';
import { buildCostQuestions } from './questions.js';
import { safeError } from '../utils/sanitize.js';

export function createVercelAiGatewayProvider(options: JevProviderOptions): JevProvider {
  return {
    id: 'vercel-ai-gateway',
    async evaluateCost(state: CostEvaluationState): Promise<JevRawAnswer> {
      if (!options.apiKey) {
        return {
          decision: null,
          confidence: 0,
          provisional: true,
          unavailableMessage: 'AI_GATEWAY_API_KEY is required for vercel-ai-gateway',
        };
      }
      try {
        const gateway = createGateway({ apiKey: options.apiKey });
        const result = await evaluate({
          model: gateway.evaluationModel(options.model ?? 'typesafe-ai/jev'),
          state: JSON.parse(JSON.stringify(state)) as never,
          questions: buildCostQuestions(),
          maxRetries: 1,
          abortSignal: AbortSignal.timeout(options.timeoutMs),
          providerOptions: {
            gateway: { zeroDataRetention: true },
          },
        });
        return answerFromEvaluateBody(result as unknown as Parameters<typeof answerFromEvaluateBody>[0]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith('SCHEMA_REJECTED')) throw error;
        return {
          decision: null,
          confidence: 0,
          provisional: true,
          unavailableMessage: `vercel-ai-gateway error: ${safeError(message)}`,
        };
      }
    },
  };
}
