import { describe, it, expect } from "vitest";
import { RateLimitedHttpStep, type RateLimiterLike } from "../lib/rate-limited-http-step.js";

class TestHttpStep extends RateLimitedHttpStep {
  readonly id = "test-http";
  protected createLimiter(): RateLimiterLike {
    let active = 0;
    let pending = 0;
    const queue: Array<() => void> = [];
    return {
      schedule: async <T>(fn: () => Promise<T>): Promise<T> => {
        if (active >= 2) {
          pending++;
          await new Promise<void>((resolve) => queue.push(resolve));
          pending--;
        }
        active++;
        try {
          return await fn();
        } finally {
          active--;
          const next = queue.shift();
          if (next) next();
        }
      },
      inFlight: () => active,
      queueDepth: () => pending,
    };
  }
  async run(): Promise<void> {}

  async doSchedule<T>(fn: () => Promise<T>): Promise<T> {
    return this.schedule(fn);
  }

  getInFlight(): number {
    return this.inFlight();
  }

  getQueueDepth(): number {
    return this.queueDepth();
  }
}

describe("RateLimitedHttpStep", () => {
  it("creates limiter lazily on first schedule call", async () => {
    const step = new TestHttpStep();
    expect(step.getInFlight()).toBe(0);
    expect(step.getQueueDepth()).toBe(0);
  });

  it("schedules fn through rate limiter", async () => {
    const step = new TestHttpStep();
    const result = await step.doSchedule(async () => 42);
    expect(result).toBe(42);
  });

  it("returns to zero in-flight after completion", async () => {
    const step = new TestHttpStep();
    await step.doSchedule(async () => "done");
    expect(step.getInFlight()).toBe(0);
  });

  it("handles schedule errors", async () => {
    const step = new TestHttpStep();
    await expect(
      step.doSchedule(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");
  });

  it("can run multiple concurrent schedules", async () => {
    const step = new TestHttpStep();
    const results = await Promise.all([
      step.doSchedule(async () => "a"),
      step.doSchedule(async () => "b"),
    ]);
    expect(results).toEqual(["a", "b"]);
  });
});
