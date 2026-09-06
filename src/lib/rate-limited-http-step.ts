/*
<MODULE_CONTRACT>
<purpose>Implements a base class for HTTP calls with rate limiting, concurrency control, and retry mechanisms.</purpose>
<non-goals>
  <item>Does not handle non-HTTP related operations.</item>
  <item>Does not provide specific rate limit configurations; subclasses must define them.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial implementation of RateLimitedHttpStep with rate limiting and retry logic.</item>
</CHANGE_SUMMARY>
*/

/**
 * RateLimitedHttpStep — abstract step with an injectable rate limiter.
 *
 * Subclasses provide a `RateLimiterLike` implementation via
 * `createLimiter()`. This decouples the step from any specific
 * rate-limiting library. HDRI apps typically use p-limit + p-retry +
 * cockatiel; external consumers can use any implementation.
 *
 * Usage:
 *   class FetchPagesStep extends RateLimitedHttpStep<MyContext> {
 *     protected createLimiter(): RateLimiterLike {
 *       const limit = pLimit(4);
 *       return {
 *         schedule: (fn) => limit(fn),
 *         inFlight: () => limit.activeCount,
 *         queueDepth: () => limit.pendingCount,
 *       };
 *     }
 *     async run(ctx: MyContext): Promise<void> {
 *       for (const url of ctx.state.urls) {
 *         await this.schedule(() => fetch(url));
 *       }
 *     }
 *   }
 */

import { PipelineStep } from "@syrokomskyi/pipeline-core";
import type { PipelineStepContext } from "@syrokomskyi/pipeline-core";

/** Minimal rate-limiter contract that any implementation can satisfy. */
export type RateLimiterLike = {
  schedule<T>(fn: () => Promise<T>): Promise<T>;
  inFlight(): number;
  queueDepth(): number;
};

export abstract class RateLimitedHttpStep<
  TContext extends PipelineStepContext = PipelineStepContext,
> extends PipelineStep<TContext> {
  #limiter: RateLimiterLike | null = null;

  /**
   * Subclass must return a rate-limiter implementation.
   * Called once per step instance — the result is cached.
   */
  protected abstract createLimiter(): RateLimiterLike;

  /**
   * Run `fn` through the step's rate limiter.
   * All calls share the same limiter instance.
   */
  protected async schedule<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.#limiter) {
      this.#limiter = this.createLimiter();
    }
    return this.#limiter.schedule(fn);
  }

  /** Current in-flight call count — useful for logs / metrics. */
  protected inFlight(): number {
    return this.#limiter?.inFlight() ?? 0;
  }

  /** Current queue depth (calls waiting for the gate). */
  protected queueDepth(): number {
    return this.#limiter?.queueDepth() ?? 0;
  }
}
