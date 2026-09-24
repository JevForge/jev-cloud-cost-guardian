export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 200;

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { name?: string; code?: string; $metadata?: { httpStatusCode?: number }; statusCode?: number };
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') return true;
  const status = err.$metadata?.httpStatusCode ?? err.statusCode;
  if (typeof status === 'number') return isRetryableStatus(status);
  return false;
}

export async function withRetries<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableError(error)) throw error;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

export async function fetchWithRetries(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  options: RetryOptions & { fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  let lastResponse: Response | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetchImpl(input, init);
    lastResponse = response;
    if (response.status === 401 || response.status === 403) return response;
    if (isRetryableStatus(response.status)) {
      if (attempt >= attempts) return response;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
      continue;
    }
    return response;
  }
  return lastResponse as Response;
}
