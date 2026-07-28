/*
<MODULE_CONTRACT>
<purpose>Abstract step that signs a source database file hash with the device signing key and writes signature artifacts.</purpose>
<non-goals>
  <item>Do not perform per-observation signing (handled by @syrokomskyi/observatory-crypto sign module).</item>
  <item>Do not modify the database after signing.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial implementation — extracted from 6 duplicated SignSourceGogol copies across factory apps 0–5.</item>
</CHANGE_SUMMARY>
*/
// @ai-invariant: signature is detached ed25519 over SHA-256 of the target data; never reuse or expose the private key

/**
 * SignSourceStep — abstract step that signs a source DB file hash with the
 * device signing key and writes the three signature artifacts:
 *   1. source-signature.json (ed25519 signature manifest)
 *   2. sign-source-summary.json
 *   3. sign-source-summary.md
 *
 * Each factory app (0-harvest-source through 5-audit-axe) had a
 * SignSourceGogol copy that differed only in appId, dbPath resolution,
 * and guide metadata. This base class owns the entire workflow; subclasses
 * provide the app-specific config via abstract methods.
 *
 * Usage:
 *   class SignSourceGogol extends SignSourceStep<PipelineContext> {
 *     override readonly id = "sign-source";
 *     override readonly guide = { ... };
 *     protected override getAppId() { return "0-harvest-source"; }
 *     protected override getDbPath(ctx) { return getCoreDbPath(year); }
 *     protected override getSourceToken(ctx) { return ctx.state.brief.sourceToken; }
 *     protected override toRelativePath(p) { return toFactoryRelativePath(p); }
 *   }
 */

import fsp from "node:fs/promises";
import {
  loadSigningKeyFromEnv,
  signSource,
  type SigningKeyConfig,
  type SourceSignatureManifest,
} from "@syrokomskyi/observatory-crypto";
import { hashDatabaseFile } from "@syrokomskyi/business-core/cross-db";
import { SignSourceReporter, type SignSummary } from "./signature-reporters.js";
import { SignatureStep, type SignatureStepContext } from "./signature-step-base.js";

export type { SignatureStepContext as SignSourceStepContext } from "./signature-step-base.js";

export abstract class SignSourceStep<
  TContext extends SignatureStepContext = SignatureStepContext,
> extends SignatureStep<TContext> {
  /** Absolute path to the DB file to sign. */
  protected abstract getDbPath(ctx: TContext): string;

  /** Source token for this run. */
  protected abstract getSourceToken(ctx: TContext): string;

  /** Convert an absolute path to a relative one for artifact output. */
  protected abstract override toRelativePath(p: string): string;

  /** App version string. Default: "0.1.0". */
  protected override getAppVersion(): string {
    return "0.1.0";
  }

  /** Number of rows signed. Default: 0. */
  protected getRowsSigned(): number {
    return 0;
  }

  /** Device ID for the summary. Default: signingKey.collectorId. */
  protected getDeviceId(_ctx: TContext, signingKey: SigningKeyConfig): string {
    return signingKey.collectorId;
  }

  /** Extra rows for the Markdown summary table. Default: none. */
  protected getExtraMdRows(_ctx: TContext, _dbPath: string): Array<[string, string]> {
    return [];
  }

  /** Hook called after signing completes. Default: no-op. */
  protected onSigned(_ctx: TContext, _summary: SignSummary): void {}

  /** Log message prefix, e.g. "core.db". When undefined, no console.log. */
  protected getLogLabel(): string | undefined {
    return undefined;
  }

  /** The signing workflow — final, subclasses do not override. */
  override async run(ctx: TContext): Promise<void> {
    const appId = this.getAppId();
    const appVersion = this.getAppVersion();
    const dbPath = this.getDbPath(ctx);
    const sourceToken = this.getSourceToken(ctx);

    const signingKey = loadSigningKeyFromEnv();

    const contentHash = await hashDatabaseFile(dbPath);
    const manifest: SourceSignatureManifest = signSource({
      signingKey,
      sourceToken,
      appId,
      appVersion,
      contentHash,
      rowsSigned: this.getRowsSigned(),
    });

    const outputDir = ctx.getGogolOutputDir(this.id);
    await fsp.mkdir(outputDir, { recursive: true });

    const reporter = new SignSourceReporter(outputDir, (p) => this.toRelativePath(p));
    const nowIso = new Date().toISOString();

    const summary: SignSummary = {
      appId,
      appVersion,
      deviceId: this.getDeviceId(ctx, signingKey),
      sourceToken,
      dbPath,
      contentHash,
      signingKeyId: manifest.signing_key_id,
      completedAt: nowIso,
    };

    await reporter.writeManifest(manifest);
    await reporter.writeSummary(summary);
    await reporter.writeSummaryMd(summary, this.getExtraMdRows(ctx, dbPath));

    this.onSigned(ctx, summary);

    const label = this.getLogLabel();
    if (label) {
      console.log(
        `[${this.id}] ${label} signed. hash=${contentHash} key=${manifest.signing_key_id}`,
      );
    }
  }
}
