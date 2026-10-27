// Unit tests — bounded retry semantics.
import { describe, expect, it, vi } from "vitest";
import { withRetry } from "../../src/core/retry.js";

class Transient extends Error {}
class Fatal extends Error {}

describe("withRetry", () => {
  it("retries transient failures and succeeds", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Transient("flaky");
        return "ok";
      },
      (e) => e instanceof Transient,
      { baseDelayMs: 1 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry non-transient failures", async () => {
    const fn = vi.fn(async () => {
      throw new Fatal("nope");
    });
    await expect(withRetry(fn, (e) => e instanceof Transient, { baseDelayMs: 1 })).rejects.toThrow("nope");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after the bounded attempt count", async () => {
    const fn = vi.fn(async () => {
      throw new Transient("always");
    });
    await expect(withRetry(fn, () => true, { attempts: 4, baseDelayMs: 1 })).rejects.toThrow("always");
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("reports each retry via onRetry", async () => {
    const seen: number[] = [];
    await withRetry(
      async (n) => {
        if (n < 3) throw new Transient("x");
        return n;
      },
      () => true,
      { baseDelayMs: 1, onRetry: (attempt) => seen.push(attempt) },
    );
    expect(seen).toEqual([1, 2]);
  });
});
