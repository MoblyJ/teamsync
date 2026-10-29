// Bounded retry for transient failures. Callers pass a shouldRetry predicate;
// mutations must verify remote state before re-attempting (see submit/PR
// creation) so a retry can never duplicate work.
export function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
export async function withRetry(fn, shouldRetry, opts = {}) {
    const attempts = opts.attempts ?? 3;
    const base = opts.baseDelayMs ?? 400;
    const max = opts.maxDelayMs ?? 8_000;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await fn(attempt);
        }
        catch (err) {
            lastError = err;
            if (attempt === attempts || !shouldRetry(err))
                throw err;
            const delay = Math.min(max, base * 2 ** (attempt - 1));
            opts.onRetry?.(attempt, err, delay);
            await sleep(delay);
        }
    }
    throw lastError; // unreachable
}
