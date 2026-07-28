/*
<MODULE_CONTRACT>
<purpose>Abstract step that verifies upstream source signatures before consuming upstream DB files.</purpose>
<non-goals>
  <item>Do not modify upstream DB files.</item>
  <item>Do not mint new asset IDs.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial implementation — extracted from 5 duplicated VerifyUpstreamGogol copies across factory apps 1–5.</item>
</CHANGE_SUMMARY>
*/
// @ai-invariant: signature is detached ed25519 over SHA-256 of the target data; never reuse or expose the private key

/**
 * VerifyUpstreamStep — abstract step that verifies ed25519 signatures on
 * every upstream device's source DB before ingestion.
 *
 * Each factory app (1-register-businesses through 5-audit-axe) had a
 * VerifyUpstreamGogol copy that differed only in: expected upstream appId,
 * DB filename pattern(s), upstream output root, and guide metadata.
 * This base class owns the entire verification loop; subclasses provide
 * the app-specific config via abstract methods.
 *
 * Usage:
 *   class VerifyUpstreamGogol extends VerifyUpstreamStep<PipelineContext> {
 *     override readonly id = "verify-upstream";
 *     override readonly guide = { ... };
 *     protected override getAppId() { return "1-register-businesses"; }
 *     protected override getExpectedUpstreamAppId() { return "0-harvest-source"; }
 *     protected override getUpstreamRoot(ctx) { return ctx.state.upstreamHarvestOutputRoot; }
 *     protected override getDbFilenames(ctx) { return [`core_${ctx.state.year}.db`]; }
 *     protected override getYear(ctx) { return ctx.state.year; }
 *     protected override getDeviceId(ctx) { return ctx.state.deviceId; }
 *     protected override getSourceToken(ctx) { return ctx.state.sourceToken; }
 *     protected override toRelativePath(p) { return toFactoryRelativePath(p); }
 *   }
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  getTransparencyKeysDir,
  listDeviceFolders,
  loadVerificationKeys,
  verifyUpstreamManifest,
  type SourceSignatureManifest,
} from "@syrokomskyi/observatory-crypto";
import { hashDatabaseFile } from "@syrokomskyi/business-core/cross-db";
import {
  VerificationReporter,
  findManifestPath,
  type VerificationEntry,
  type VerificationSummary,
} from "./signature-reporters.js";
import { SignatureStep, type SignatureStepContext } from "./signature-step-base.js";

export type { SignatureStepContext as VerifyUpstreamStepContext } from "./signature-step-base.js";

export abstract class VerifyUpstreamStep<
  TContext extends SignatureStepContext = SignatureStepContext,
> extends SignatureStep<TContext> {
  /** The upstream app ID to look for in manifests, e.g. "0-harvest-source". */
  protected abstract getExpectedUpstreamAppId(): string;

  /** Root directory of the upstream app's .output/ (parent of all device folders). */
  protected abstract getUpstreamRoot(ctx: TContext): string;

  /** DB filename(s) to verify, e.g. ["core_2026.db"] or ["pages-2026-h1.db", "pages-2026-h2.db"]. */
  protected abstract getDbFilenames(ctx: TContext): string[];

  /** Year for the verification summary. */
  protected abstract getYear(ctx: TContext): number;

  /** This device's ID for the summary. */
  protected abstract getDeviceId(ctx: TContext): string;

  /** Source token for the summary. */
  protected abstract getSourceToken(ctx: TContext): string;

  /** Convert an absolute path to a relative one for artifact output. */
  protected abstract override toRelativePath(p: string): string;

  /** App version string. Default: "0.1.0". */
  protected override getAppVersion(): string {
    return "0.1.0";
  }

  /** The verification workflow — final, subclasses do not override. */
  override async run(ctx: TContext): Promise<void> {
    const appId = this.getAppId();
    const appVersion = this.getAppVersion();
    const expectedUpstreamAppId = this.getExpectedUpstreamAppId();
    const upstreamRoot = this.getUpstreamRoot(ctx);
    const dbFilenames = this.getDbFilenames(ctx);
    const year = this.getYear(ctx);
    const deviceId = this.getDeviceId(ctx);
    const sourceToken = this.getSourceToken(ctx);

    const transparencyDir = getTransparencyKeysDir();
    const keyMap = await loadVerificationKeys(transparencyDir);
    console.log(`[${this.id}] Loaded ${keyMap.size} verification key(s) from ${transparencyDir}`);

    const devices = await listDeviceFolders(upstreamRoot);
    const entries: VerificationEntry[] = [];
    let allOk = true;

    for (const dev of devices) {
      for (const dbFilename of dbFilenames) {
        const dbPath = path.join(dev.path, "data", "db", dbFilename);
        if (!fs.existsSync(dbPath)) {
          continue;
        }

        const manifestPath = await findManifestPath(dev.path, {
          expectedAppId: expectedUpstreamAppId,
        });
        if (!manifestPath) {
          allOk = false;
          entries.push({
            deviceId: dev.deviceId,
            dbPath,
            manifestPath: "",
            ok: false,
            reason: "Missing source-signature.json",
            contentHash: "",
          });
          continue;
        }

        const manifest: SourceSignatureManifest = JSON.parse(
          await fsp.readFile(manifestPath, "utf-8"),
        );
        const verifyResult = verifyUpstreamManifest(manifest, keyMap);

        if (!verifyResult.ok) {
          allOk = false;
          entries.push({
            deviceId: dev.deviceId,
            dbPath,
            manifestPath,
            ok: false,
            reason: verifyResult.reason,
            contentHash: manifest.content_hash,
          });
          continue;
        }

        const computedHash = await hashDatabaseFile(dbPath);
        if (computedHash !== manifest.content_hash) {
          allOk = false;
          entries.push({
            deviceId: dev.deviceId,
            dbPath,
            manifestPath,
            ok: false,
            reason: `Hash mismatch: manifest=${manifest.content_hash} computed=${computedHash}`,
            contentHash: manifest.content_hash,
            computedHash,
          });
          continue;
        }

        entries.push({
          deviceId: dev.deviceId,
          dbPath,
          manifestPath,
          ok: true,
          contentHash: manifest.content_hash,
          computedHash,
        });
      }
    }

    const outputDir = ctx.getGogolOutputDir(this.id);
    await fsp.mkdir(outputDir, { recursive: true });

    const reporter = new VerificationReporter(outputDir, (p) => this.toRelativePath(p));
    const nowIso = new Date().toISOString();

    const summary: VerificationSummary = {
      appId,
      appVersion,
      deviceId,
      sourceToken,
      year,
      upstreamRoot,
      transparencyDir,
      allOk,
      entries,
      completedAt: nowIso,
    };

    await reporter.writeSummary(summary);
    await reporter.writeSummaryMd(summary);

    if (!allOk) {
      const failed = entries.filter((e) => !e.ok);
      throw new Error(
        `Upstream verification failed for ${failed.length} device(s): ` +
          failed.map((f) => `${f.deviceId} (${f.reason})`).join("; "),
      );
    }

    console.log(`[${this.id}] All ${entries.length} upstream signature(s) verified.`);
  }
}
