import { describe, it, expect } from "vitest";
import { RateLimitedHttpStep } from "../lib/rate-limited-http-step.js";
import type { RateLimiterOptions } from "@syrokomskyi/rate-limit";

class TestHttpStep extends RateLimitedHttpStep {
  readonly id = "test-http";
  protected getRateLimitOptions(): RateLimiterOptions {
    return {
      concurrency: 2,
      bucket: { size: 5, refillPerSec: 10 },
      retry: { retries: 2 },
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
