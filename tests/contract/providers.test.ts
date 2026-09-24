import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('ai', () => ({
  createGateway: () => ({
    evaluationModel: (modelId: string) => ({ modelId }),
  }),
  experimental_evaluate: vi.fn(),
}));

import { experimental_evaluate } from 'ai';
import { createJevProvider } from '../../src/jev/factory.js';
import { buildEvaluationState } from '../../src/jev/questions.js';
import { line, report } from '../helpers.js';

const evaluate = vi.mocked(experimental_evaluate);
const state = buildEvaluationState(
  report([
    line({ address: 'baseline', monthly_cost: 100, change: 'baseline', service: 'baseline', resource_type: 'baseline' }),
  ]),
);

describe('Jev providers', () => {
  beforeEach(() => {
    evaluate.mockReset();
  });

  it('calls experimental_evaluate on typesafe-ai/jev and does not use generateText', async () => {
    const source = readFileSync(new URL('../../src/jev/vercel-ai-gateway.ts', import.meta.url), 'utf8');
    expect(source).toContain('experimental_evaluate');
    expect(source).not.toContain('generateText');
    evaluate.mockResolvedValue({
      answers: {
        decision: { type: 'choice', choice: 'approve', probabilities: { approve: 0.93 } },
        estimates_incomplete: { type: 'boolean', probability: 0.05 },
      },
      providerMetadata: { typesafe: { confidence: { decision: 0.93 } } },
    } as never);
    const provider = createJevProvider({
      provider: 'vercel-ai-gateway',
      apiKey: 'test-key',
      timeoutMs: 1000,
    });
    const answer = await provider.evaluateCost(state);
    expect(answer.decision).toBe('approve');
    expect(answer.confidence).toBe(0.93);
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { modelId: 'typesafe-ai/jev' },
      }),
    );
  });

  it('does not fall back to another provider when the gateway key is missing', async () => {
    const provider = createJevProvider({ provider: 'vercel-ai-gateway', timeoutMs: 1000 });
    const answer = await provider.evaluateCost(state);
    expect(answer.unavailableMessage).toContain('vercel-ai-gateway');
    expect(answer.unavailableMessage).not.toContain('typesafe-native');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('normalizes native and custom HTTPS answers to the same choice contract', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          answers: {
            decision: { type: 'choice', choice: 'manual-review' },
            estimates_incomplete: { type: 'boolean', probability: 0.8 },
          },
          confidence: { decision: 0.66 },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const native = createJevProvider({
      provider: 'typesafe-native',
      apiKey: 'native-key',
      endpoint: 'https://jev.example/evaluate',
      model: 'typesafe-ai/jev',
      timeoutMs: 1000,
      fetchImpl,
    });
    const custom = createJevProvider({
      provider: 'custom-compatible',
      apiKey: 'custom-key',
      endpoint: 'https://jev.example/evaluate',
      model: 'typesafe-ai/jev',
      timeoutMs: 1000,
      fetchImpl,
    });
    const nativeAnswer = await native.evaluateCost(state);
    const customAnswer = await custom.evaluateCost(state);
    expect(nativeAnswer).toEqual(customAnswer);
    expect(nativeAnswer.decision).toBe('manual-review');
  });

  it('rejects malformed choices and HTTP failures without approving', async () => {
    const malformed = createJevProvider({
      provider: 'custom-compatible',
      apiKey: 'custom-key',
      endpoint: 'https://jev.example/evaluate',
      model: 'typesafe-ai/jev',
      timeoutMs: 1000,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ answers: { decision: { type: 'choice', choice: 'apply' } } }), {
          status: 200,
        })) as typeof fetch,
    });
    await expect(malformed.evaluateCost(state)).rejects.toThrow(/SCHEMA_REJECTED/);

    const down = createJevProvider({
      provider: 'typesafe-native',
      apiKey: 'native-key',
      endpoint: 'https://jev.example/evaluate',
      model: 'typesafe-ai/jev',
      timeoutMs: 1000,
      fetchImpl: (async () => new Response('nope', { status: 503 })) as typeof fetch,
    });
    const answer = await down.evaluateCost(state);
    expect(answer.provisional).toBe(true);
    expect(answer.decision).toBeNull();

    const insecure = createJevProvider({
      provider: 'custom-compatible',
      apiKey: 'custom-key',
      endpoint: 'http://jev.example/evaluate',
      model: 'typesafe-ai/jev',
      timeoutMs: 1000,
    });
    expect((await insecure.evaluateCost(state)).unavailableMessage).toMatch(/HTTPS/);
  });
});
