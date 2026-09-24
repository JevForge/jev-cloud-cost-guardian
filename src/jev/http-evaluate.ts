import { DECISIONS } from '../schemas/enums.js';
import { safeError } from '../utils/sanitize.js';
import type { JevRawAnswer } from './types.js';

interface EvaluateBody {
  answers?: {
    decision?: { type?: string; choice?: string; probabilities?: Record<string, number>; confidence?: number };
    estimates_incomplete?: { type?: string; probability?: number };
  };
  confidence?: Record<string, number>;
  providerMetadata?: { typesafe?: { confidence?: Record<string, number> } };
}

export function answerFromEvaluateBody(body: EvaluateBody): JevRawAnswer {
  const selected = body.answers?.decision;
  if (!selected || selected.type !== 'choice' || typeof selected.choice !== 'string') {
    throw new Error('SCHEMA_REJECTED: missing decision choice');
  }
  if (!(DECISIONS as readonly string[]).includes(selected.choice)) {
    throw new Error('SCHEMA_REJECTED: decision is outside approve|warn|block|manual-review');
  }
  const metadata = body.providerMetadata?.typesafe?.confidence?.decision;
  const probability = selected.probabilities?.[selected.choice];
  const confidence = metadata ?? body.confidence?.decision ?? selected.confidence ?? probability ?? 0.5;
  const incomplete = body.answers?.estimates_incomplete;
  return {
    decision: selected.choice,
    confidence,
    incompleteProbability: incomplete?.type === 'boolean' ? incomplete.probability : undefined,
    provisional: false,
    unavailableMessage: undefined,
  };
}

export async function postEvaluate(options: {
  endpoint: string;
  apiKey: string;
  model: string;
  state: unknown;
  questions: unknown;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  providerLabel: string;
}): Promise<JevRawAnswer> {
  try {
    const response = await options.fetchImpl(options.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        state: options.state,
        questions: options.questions,
      }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      return {
        decision: null,
        confidence: 0,
        provisional: true,
        unavailableMessage: `${options.providerLabel} HTTP ${response.status}: ${safeError(await response.text())}`,
      };
    }
    return answerFromEvaluateBody((await response.json()) as EvaluateBody);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('SCHEMA_REJECTED')) throw error;
    return {
      decision: null,
      confidence: 0,
      provisional: true,
      unavailableMessage: `${options.providerLabel} error: ${safeError(message)}`,
    };
  }
}
