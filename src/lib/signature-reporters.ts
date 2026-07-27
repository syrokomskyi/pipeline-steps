/*
<MODULE_CONTRACT>
<purpose>Shared utilities for signing and verification artifact emission — reporters, manifest finder, and summary types.</purpose>
<non-goals>
  <item>Do not perform actual signing or cryptographic verification (handled by @syrokomskyi/observatory-crypto).</item>
  <item>Do not manage database connections or business logic.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Extracted from @syrokomskyi/observatory-emit/src/signature.ts as part of the package split (Candidate 3).</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import fsp from "node:fs/promises";
import { markdownTable } from "markdown-table";
import type { SourceSignatureManifest } from "@syrokomskyi/observatory-crypto";

// ── File writing helpers (inlined to avoid @syrokomskyi/pipeline-node dependency) ────

async function writeTextFile(filePath: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${content}\n`, "utf-8");
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeTextFile(filePath, JSON.stringify(value, null, 2));
}

// ── Sign source reporter ─────────────────────────────────────────────────────

/** Renders a key-value table as Markdown for summary artifacts. */
export function renderKeyValueMd(title: string, values: Array<[string, string]>): string {
  return [
    `# ${title}`,
    ``,
    markdownTable([["Metric", "Value"], ...values], { align: ["l", "l"] }),
  ].join("\n");
}

/** Summary data for a signing operation. */
export type SignSummary = {
  appId: string;
  appVersion: string;
  deviceId: string;
  sourceToken: string;
  dbPath: string;
  contentHash: string;
  signingKeyId: string;
  completedAt: string;
  rowsSigned?: number;
};

/** Helper class to write signing artifacts consistently. */
export class SignSourceReporter {
  private readonly outputDir: string;
  private readonly toRelativePath: (p: string) => string;

  constructor(outputDir: string, toRelativePath: (p: string) => string) {
    this.outputDir = outputDir;
    this.toRelativePath = toRelativePath;
  }

  /** Writes source-signature.json manifest. */
  async writeManifest(manifest: SourceSignatureManifest): Promise<void> {
    await writeJsonFile(path.join(this.outputDir, "source-signature.json"), manifest);
  }

  /** Writes sign-source-summary.json with the provided data. */
  async writeSummary(summary: SignSummary): Promise<void> {
    await writeJsonFile(path.join(this.outputDir, "sign-source-summary.json"), {
      ...summary,
      dbPath: this.toRelativePath(summary.dbPath),
    });
  }

  /** Writes sign-source-summary.md markdown report. */
  async writeSummaryMd(
    summary: SignSummary,
    extraRows: Array<[string, string]> = [],
  ): Promise<void> {
    const manifestPath = path.join(this.outputDir, "source-signature.json");

    const rows: Array<[string, string]> = [
      ["Content hash", `\`${summary.contentHash}\``],
      ["Signing key ID", `\`${summary.signingKeyId}\``],
      ["Signature manifest", this.toRelativePath(manifestPath)],
      ...extraRows,
    ];

    if (summary.rowsSigned !== undefined) {
      rows.unshift(["Rows signed", String(summary.rowsSigned)]);
    }

    const md = renderKeyValueMd("Sign source", rows);
    await writeTextFile(path.join(this.outputDir, "sign-source-summary.md"), md);
  }
}

// ── Verify upstream reporter ─────────────────────────────────────────────────

/** Entry in verification results for a single upstream device. */
export type VerificationEntry = {
  deviceId: string;
  dbPath: string;
  manifestPath: string;
  ok: boolean;
  reason?: string;
  contentHash: string;
  computedHash?: string;
};

/** Summary data for upstream verification. */
export type VerificationSummary = {
  appId: string;
  appVersion: string;
  deviceId: string;
  sourceToken: string;
  year: number;
  upstreamRoot: string;
  transparencyDir: string;
  allOk: boolean;
  entries: VerificationEntry[];
  completedAt: string;
};

/** Helper class to write verification artifacts consistently. */
export class VerificationReporter {
  private readonly outputDir: string;
  private readonly toRelativePath: (p: string) => string;

  constructor(outputDir: string, toRelativePath: (p: string) => string) {
    this.outputDir = outputDir;
    this.toRelativePath = toRelativePath;
  }

  /** Writes verify-upstream-summary.json with normalized paths. */
  async writeSummary(summary: VerificationSummary): Promise<void> {
    await writeJsonFile(path.join(this.outputDir, "verify-upstream-summary.json"), {
      appId: summary.appId,
      appVersion: summary.appVersion,
      deviceId: summary.deviceId,
      sourceToken: summary.sourceToken,
      year: summary.year,
      upstreamHarvestOutputRoot: this.toRelativePath(summary.upstreamRoot),
      transparencyDir: this.toRelativePath(summary.transparencyDir),
      allOk: summary.allOk,
      entries: summary.entries.map((e) => ({
        ...e,
        dbPath: this.toRelativePath(e.dbPath),
        manifestPath: e.manifestPath ? this.toRelativePath(e.manifestPath) : "",
      })),
      completedAt: summary.completedAt,
    });
  }

  /** Writes verify-upstream-summary.md markdown report. */
  async writeSummaryMd(summary: VerificationSummary): Promise<void> {
    const mdRows = summary.entries.map((e) => [
      e.deviceId,
      e.ok ? "✓" : "✗",
      e.reason ?? "",
      e.contentHash ? `\`${e.contentHash}\`` : "",
    ]);

    const md = [
      `# Verify upstream signatures`,
      ``,
      `**Result:** ${summary.allOk ? "PASS ✓" : "FAIL ✗"}`,
      ``,
      markdownTable([["Device", "OK", "Reason", "Content hash"], ...mdRows], {
        align: ["l", "c", "l", "l"],
      }),
    ].join("\n");

    await writeTextFile(path.join(this.outputDir, "verify-upstream-summary.md"), md);
  }
}

// ── Manifest finder ──────────────────────────────────────────────────────────

/** Options for finding manifests. */
export type FindManifestOptions = {
  expectedAppId: string;
  filename?: string;
};

/**
 * Finds a manifest file (default: source-signature.json) in deviceOutputDir
 * written by expectedAppId. Scans all step subdirectories and checks
 * manifest.app_id instead of relying on a directory name convention.
 */
export async function findManifestPath(
  deviceOutputDir: string,
  options: FindManifestOptions,
): Promise<string | undefined> {
  const { expectedAppId, filename = "source-signature.json" } = options;

  try {
    const entries = await fsp.readdir(deviceOutputDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const candidate = path.join(deviceOutputDir, e.name, filename);
      try {
        const raw = await fsp.readFile(candidate, "utf-8");
        const m = JSON.parse(raw) as Partial<SourceSignatureManifest>;
        if (m.app_id === expectedAppId) {
          return candidate;
        }
      } catch {
        // not a readable manifest — skip
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}
