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

  it('retries network-style errors and stops on non-retryable ones', async () => {
    const sleep = vi.fn(async () => undefined);
    let calls = 0;
    await expect(
      withRetries(
        async () => {
          calls += 1;
          const error = new Error('reset') as Error & { code: string };
          error.code = 'ECONNRESET';
          throw error;
        },
        { sleep, baseDelayMs: 1, attempts: 2 },
      ),
    ).rejects.toThrow(/reset/);
    expect(calls).toBe(2);

    await expect(
      withRetries(async () => {
        throw new Error('permanent');
      }, { attempts: 3, sleep }),
    ).rejects.toThrow(/permanent/);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
