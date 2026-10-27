// Bounded retry for transient failures. Callers pass a shouldRetry predicate;
// mutations must verify remote state before re-attempting (see submit/PR
// creation) so a retry can never duplicate work.

export interface RetryOptions {
  attempts?: number; // total attempts, default 3
  baseDelayMs?: number; // default 400ms
  maxDelayMs?: number; // default 8000ms
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 400;
  const max = opts.maxDelayMs ?? 8_000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !shouldRetry(err)) throw err;
      const delay = Math.min(max, base * 2 ** (attempt - 1));
      opts.onRetry?.(attempt, err, delay);
      await sleep(delay);
    }
  }
  throw lastError; // unreachable
}
