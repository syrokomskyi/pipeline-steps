/*
<MODULE_CONTRACT>
<purpose>Manages a pool of Playwright browser contexts for concurrent page visits in a pipeline step.</purpose>
<non-goals>
  <item>Does not handle installation of Playwright dependency.</item>
  <item>Does not provide specific page interaction logic beyond context management.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial implementation of PlaywrightPooledStep with concurrency management.</item>
</CHANGE_SUMMARY>
*/

/**
 * PlaywrightPooledStep — abstract step with a managed Playwright browser pool.
 *
 * Launches a single Chromium instance per step run, then hands out contexts
 * (one per page visit) with a bounded concurrency gate. Closes the browser
 * automatically after `run()` returns (or throws).
 *
 * Playwright is imported dynamically to avoid forcing the dependency on
 * every consumer of `@syrokomskyi/pipeline-steps`. Install `playwright` in the
 * app that uses this step class.
 *
 * Extracted from Phase 6 (site-deep-audit AxeAuditGogol) per AGENTS.md
 * anti-pattern rule: "Do not leave repeated app-local wrappers in place".
 *
 * Usage:
 *   class MyAuditStep extends PlaywrightPooledStep<MyContext> {
 *     protected getPoolConcurrency() { return 2; }
 *     async run(ctx: MyContext): Promise<void> {
 *       await this.withBrowser(async (browser) => {
 *         for (const url of ctx.state.urls) {
 *           await this.withPage(browser, async (page) => {
 *             await page.goto(url);
 *             // …
 *           });
 *         }
 *       });
 *     }
 *   }
 */

import { PipelineStep } from "@syrokomskyi/pipeline-core";
import type { PipelineStepContext } from "@syrokomskyi/pipeline-core";
import { ConcurrencyGate } from "@syrokomskyi/rate-limit";

// ---------------------------------------------------------------------------
// Minimal Playwright type shims (keeps this package dependency-free at
// compile time; real types come from the consuming app).
// ---------------------------------------------------------------------------

export type PlaywrightBrowser = {
  newContext(opts?: unknown): Promise<PlaywrightContext>;
  close(): Promise<void>;
};
export type PlaywrightContext = {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
};
export type PlaywrightPage = {
  goto(url: string, opts?: unknown): Promise<unknown>;
  close(): Promise<void>;
  // Allow consumers to use any additional page methods.
  [k: string]: unknown;
};

// ---------------------------------------------------------------------------

export type BrowserLaunchOptions = {
  headless?: boolean;
  args?: string[];
  timeout?: number;
};

export abstract class PlaywrightPooledStep<
  TContext extends PipelineStepContext = PipelineStepContext,
> extends PipelineStep<TContext> {
  /**
   * Max concurrent pages (contexts) across the pool. Default: 2.
   * Override to adjust per-step concurrency.
   */
  protected getPoolConcurrency(): number {
    return 2;
  }

  /** Override to change Chromium launch options. */
  protected getLaunchOptions(): BrowserLaunchOptions {
    return { headless: true };
  }

  /**
   * Launches Chromium, runs `fn` with the browser, then closes the browser.
   * Subclass typically calls this once at the top of `run()`.
   */
  protected async withBrowser<T>(fn: (browser: PlaywrightBrowser) => Promise<T>): Promise<T> {
    const playwright = await import("playwright" as string);
    const browser = await playwright.chromium.launch(this.getLaunchOptions());
    try {
      return await fn(browser as PlaywrightBrowser);
    } finally {
      await browser.close();
    }
  }

  /**
   * Opens a fresh context + page, runs `fn`, then closes both.
   * Enforces `getPoolConcurrency()` via an internal ConcurrencyGate.
   *
   * Each call gets an isolated browser context — safe for parallel scrapes
   * without cookie / cache cross-contamination.
   */
  protected async withPage<T>(
    browser: PlaywrightBrowser,
    fn: (page: PlaywrightPage) => Promise<T>,
  ): Promise<T> {
    if (!this.#gate) this.#gate = new ConcurrencyGate(this.getPoolConcurrency());
    return this.#gate.run(async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        try {
          return await fn(page);
        } finally {
          await page.close();
        }
      } finally {
        await context.close();
      }
    });
  }

  #gate: ConcurrencyGate | null = null;
}
