import { describe, expect, it, vi } from 'vitest';
import { fetchWithRetries, withRetries } from '../../src/utils/retry.js';

describe('retry helper', () => {
  it('retries retryable failures then succeeds', async () => {
    const sleep = vi.fn(async () => undefined);
    let calls = 0;
    const result = await withRetries(
      async () => {
        calls += 1;
        if (calls < 3) {
          const error = new Error('boom') as Error & { statusCode: number };
          error.statusCode = 503;
          throw error;
        }
        return 'ok';
      },
      { sleep, baseDelayMs: 1 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry auth failures from fetch', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    const response = await fetchWithRetries('https://example.test', undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      attempts: 3,
    });
    expect(response.status).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns the final retryable response after exhausting attempts', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => new Response('busy', { status: 429 }));
    const response = await fetchWithRetries('https://example.test', undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      attempts: 3,
      sleep,
      baseDelayMs: 1,
    });
    expect(response.status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
