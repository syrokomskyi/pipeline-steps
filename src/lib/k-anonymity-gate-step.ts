/*
<MODULE_CONTRACT>
<purpose>Enforces DSGVO k-anonymity on data strata before public disclosure by suppressing or flagging small strata.</purpose>
<non-goals>
  <item>Does not provide specific data strata; subclasses must implement data collection.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial implementation of k-anonymity enforcement with reporting and suppression capabilities.</item>
</CHANGE_SUMMARY>
*/

/**
 * KAnonymityGateStep — abstract step that enforces DSGVO k-anonymity on
 * any set of strata before public disclosure.
 *
 * The extracted pattern from hdri-publication's EnforceKAnonymityGogol:
 *   1. Collect strata (dimension, key, count)
 *   2. Flag each stratum where count < K_MIN (governance §DSGVO, default K=5)
 *   3. Either suppress small strata (mode='warn') or throw (mode='enforce')
 *   4. Write a report artifact listing every stratum + suppression reason
 *
 * Subclasses provide the strata — the base class handles the gating.
 * The default K_MIN is 5 (governance §DSGVO).
 *
 * Usage:
 *   class PublishKGateStep extends KAnonymityGateStep<MyContext> {
 *     protected collectStrata(ctx: MyContext): Stratum[] {
 *       return [
 *         ...ctx.state.dataset.aggregates.gewerkBreakdown.map(e => ({
 *           dimension: 'gewerk', key: e.key, count: e.count,
 *         })),
 *         // …
 *       ];
 *     }
 *     protected getMode(ctx: MyContext): 'warn' | 'enforce' {
 *       return ctx.state.brief.kAnonymityMode ?? 'warn';
 *     }
 *     async run(ctx: MyContext): Promise<void> {
 *       const result = await this.enforceKAnonymity(ctx);
 *       if (result.suppressed.length > 0) {
 *         // subclass decides how to mutate the dataset, e.g.
 *         const suppressedKeys = new Set(result.suppressed.map(s => s.key));
 *         ctx.state.dataset.aggregates.gewerkBreakdown =
 *           ctx.state.dataset.aggregates.gewerkBreakdown.filter(
 *             e => !suppressedKeys.has(e.key)
 *           );
 *       }
 *     }
 *   }
 */

import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { PipelineStep } from "@syrokomskyi/pipeline-core";
import type { PipelineStepContext } from "@syrokomskyi/pipeline-core";

/** Default minimum stratum size for public disclosure (governance §DSGVO). */
export const DEFAULT_K_MIN = 5;

export interface Stratum {
  /** Stratum dimension, e.g. 'gewerk', 'bundesland', 'gewerk×bundesland'. */
  dimension: string;
  /** Stratum key within the dimension, e.g. 'sanitaer', 'Bayern'. */
  key: string;
  /** Number of underlying units (sites) in this stratum. */
  count: number;
}

export interface StratumResult extends Stratum {
  suppressed: boolean;
  reason: string | null;
}

export interface KAnonymityReport {
  k_min: number;
  mode: "warn" | "enforce";
  total_strata: number;
  suppressed_strata: number;
  passed: boolean;
  strata: StratumResult[];
}

export interface KAnonymityOutcome {
  report: KAnonymityReport;
  /** Strata that did not meet the threshold. Subclass decides how to mutate data. */
  suppressed: StratumResult[];
  /** True when every stratum met the threshold. */
  passed: boolean;
  /** Absolute path of the report artifact. */
  reportPath: string;
}

export abstract class KAnonymityGateStep<
  TContext extends PipelineStepContext = PipelineStepContext,
> extends PipelineStep<TContext> {
  /** Threshold — override if governance demands something other than 5. */
  protected getKMin(): number {
    return DEFAULT_K_MIN;
  }

  /** 'warn' suppresses small strata; 'enforce' throws. Default: 'warn'. */
  protected getMode(_ctx: TContext): "warn" | "enforce" {
    return "warn";
  }

  /** Subclass returns every stratum that will be gated. */
  protected abstract collectStrata(ctx: TContext): Stratum[] | Promise<Stratum[]>;

  /**
   * Subclass returns the directory to write `report.json` into.
   * Default: `ctx.getStepArtifactPath(this.id, '')` — which most pipelines
   * resolve to `<runDir>/<stepId>/`.
   */
  protected getOutputDir(ctx: TContext): string {
    return this.getArtifactPath(ctx, "");
  }

  /**
   * Runs the k-anonymity check, writes `report.json`, returns the outcome.
   * Throws if mode is 'enforce' and at least one stratum is below K_MIN.
   */
  protected async enforceKAnonymity(ctx: TContext): Promise<KAnonymityOutcome> {
    const kMin = this.getKMin();
    const mode = this.getMode(ctx);
    const strata = await this.collectStrata(ctx);

    const results: StratumResult[] = strata.map((s) => {
      const suppressed = s.count < kMin;
      return {
        ...s,
        suppressed,
        reason: suppressed ? `count ${s.count} < k_min ${kMin}` : null,
      };
    });

    const suppressed = results.filter((r) => r.suppressed);
    const passed = suppressed.length === 0;

    const report: KAnonymityReport = {
      k_min: kMin,
      mode,
      total_strata: results.length,
      suppressed_strata: suppressed.length,
      passed,
      strata: results,
    };

    const outDir = this.getOutputDir(ctx);
    await mkdir(outDir, { recursive: true });
    const reportPath = path.join(outDir, "report.json");
    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");

    if (!passed) {
      console.warn(`[${this.id}] Suppressed ${suppressed.length} strata below k=${kMin}:`);
      for (const s of suppressed) {
        console.warn(`  ${s.dimension}="${s.key}" count=${s.count}`);
      }
      if (mode === "enforce") {
        throw new Error(
          `[${this.id}] FAILED — ${suppressed.length} strata below k=${kMin}. ` +
            `Switch mode to 'warn' to suppress instead of failing. ` +
            `See ${reportPath} for details.`,
        );
      }
    } else {
      console.log(
        `[${this.id}] ✓ All ${results.length} strata meet k≥${kMin}. No suppression needed.`,
      );
    }

    return { report, suppressed, passed, reportPath };
  }
}
