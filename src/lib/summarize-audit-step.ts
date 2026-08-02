/*
<MODULE_CONTRACT>
<purpose>Abstract step that generates an audit snapshot report with per-tool counts, tool-specific stats, DB hashes, and provenance.</purpose>
<non-goals>
  <item>Do not run audit tools or generate raw reports.</item>
  <item>Do not manage database schema or migrations.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial implementation — extracted from duplicated SummarizeAuditGogol in 4-audit-lighthouse and 5-audit-axe.</item>
  <item>Make SummarizeAuditStep generic over TStats to eliminate as-unknown-as double-casts in subclasses.</item>
</CHANGE_SUMMARY>
*/
// @ai-invariant: snapshot integrity is verified by SHA-256; never modify a frozen snapshot

import fs from "node:fs/promises";
import path from "node:path";
import { markdownTable } from "markdown-table";
import { PipelineStep } from "@syrokomskyi/pipeline-core";
import type { PipelineStepContext } from "@syrokomskyi/pipeline-core";
import { hashDatabaseFile } from "@syrokomskyi/business-core/cross-db";

/** Context shape required by SummarizeAuditStep. */
export type SummarizeAuditStepContext = PipelineStepContext & {
  getGogolOutputDir: (id: string) => string;
  writeTextFile: (filePath: string, content: string) => Promise<void>;
};

/** Tool-specific stats extracted from the audits DB — subclass defines the concrete type. */
export type ToolStats = Record<string, unknown>;

/** Result of querying per-tool counts from audit_runs. */
type ToolCountStats = { attempted: number; ok: number };

const fileExists = async (p: string): Promise<boolean> => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * SummarizeAuditStep — abstract step that generates an audit snapshot report.
 *
 * Owns the common workflow: open audits DB, query per-tool counts, query total
 * sites, hash DB files, build JSON snapshot, and write JSON + Markdown artifacts.
 *
 * Subclasses provide:
 * - `getAuditsDbPath(period)` — path to the audits DB file
 * - `getAuditsDbName(period)` — name without extension
 * - `openAuditsDb(dbPath)` — opens the DB connection
 * - `queryToolStats(db)` — tool-specific stats (lighthouse averages, axe totals)
 * - `getToolStatsSnapshot(stats)` — stats fields for the JSON snapshot
 * - `formatToolStatsMarkdown(stats)` — markdown section for tool-specific stats
 * - `getRegistryDbPath(ctx)` — path to registry.db for provenance
 * - `getPeriod(ctx)` — period for the snapshot
 */
export abstract class SummarizeAuditStep<
  TContext extends SummarizeAuditStepContext = SummarizeAuditStepContext,
  TStats extends ToolStats = ToolStats,
> extends PipelineStep<TContext> {
  override getPromptFileNames(): string[] {
    return [];
  }

  override getArtifactPath(ctx: TContext, artifactId: string): string {
    return path.join(ctx.getGogolOutputDir(this.id), artifactId);
  }

  /** Path to the audits DB file for the given immutable period. */
  protected abstract getAuditsDbPath(period: string): string;

  /** Audits DB name (without .db extension) for the given immutable period. */
  protected abstract getAuditsDbName(period: string): string;

  /** Open the audits DB connection. */
  protected abstract openAuditsDb(dbPath: string): import("better-sqlite3").Database;

  /** Query tool-specific stats from the audits DB. */
  protected abstract queryToolStats(db: import("better-sqlite3").Database): TStats;

  /** Extract tool-specific fields for the JSON snapshot. */
  protected abstract getToolStatsSnapshot(stats: TStats): Record<string, unknown>;

  /** Format tool-specific markdown section(s) for the snapshot report. */
  protected abstract formatToolStatsMarkdown(stats: TStats): string[];

  /** Path to registry.db for provenance. */
  protected abstract getRegistryDbPath(ctx: TContext): string;

  /** Period for the snapshot. */
  protected abstract getPeriod(ctx: TContext): string;

  override async run(ctx: TContext): Promise<void> {
    const period = this.getPeriod(ctx);
    const registryDbPath = this.getRegistryDbPath(ctx);

    const dbPath = this.getAuditsDbPath(period);
    const dbName = this.getAuditsDbName(period);
    const db = this.openAuditsDb(dbPath);

    const byTool = new Map<string, ToolCountStats>();
    const rows = db
      .prepare(
        `
      SELECT tool, COUNT(*) AS n, SUM(ok) AS ok_n
      FROM audit_runs
      GROUP BY tool
    `,
      )
      .all() as Array<{ tool: string; n: number; ok_n: number | null }>;
    for (const r of rows) byTool.set(r.tool, { attempted: r.n, ok: r.ok_n ?? 0 });

    const toolStats = this.queryToolStats(db);

    const totalSites = (
      db
        .prepare(
          `
        SELECT COUNT(DISTINCT site_id) AS n FROM audit_runs
      `,
        )
        .get() as { n: number }
    ).n;

    db.close();

    console.log(`[${this.id}] Hashing ${dbName}.db…`);
    const dbSha = await hashDatabaseFile(dbPath);
    const coreSha =
      registryDbPath && (await fileExists(registryDbPath))
        ? await hashDatabaseFile(registryDbPath)
        : null;

    const doneAt = new Date().toISOString();
    console.log(
      `[${this.id}] Done. ` +
        `tools=${Array.from(byTool.keys()).join(",")} ` +
        `sha256=${dbSha.slice(0, 12)}…`,
    );

    const snapshot = {
      doneAt,
      auditPeriod: period,
      totalSites,
      byTool: Object.fromEntries(byTool),
      ...this.getToolStatsSnapshot(toolStats),
      outputs: {
        dbPath,
        dbName: `${dbName}.db`,
        sha256: dbSha,
      },
      provenance: [{ sourceApp: "catalog-harvest", dbPath: registryDbPath, sha256: coreSha }],
    };

    const outDir = ctx.getGogolOutputDir(this.id);
    await ctx.writeTextFile(
      path.join(outDir, "audit-snapshot.json"),
      JSON.stringify(snapshot, null, 2),
    );

    await ctx.writeTextFile(
      path.join(outDir, "audit-snapshot.md"),
      [
        `# Audit snapshot`,
        ``,
        `**Batch:** audit  `,
        ``,
        `**Audit period:** ${period}  `,
        `**Total Sites:** ${totalSites}  `,
        `**Completed:** ${doneAt}`,
        ``,
        `## Per-tool counts`,
        ``,
        markdownTable(
          [
            ["Tool", "Attempted", "OK"],
            ...Array.from(byTool.entries()).map(([t, s]) => [t, String(s.attempted), String(s.ok)]),
          ],
          { align: ["l", "r", "r"] },
        ),
        ``,
        ...this.formatToolStatsMarkdown(toolStats),
        ``,
        `## Provenance`,
        ``,
        markdownTable(
          [
            ["DB", "SHA-256"],
            [`${dbName}.db`, `\`${dbSha}\``],
            ["registry.db", coreSha ? `\`${coreSha}\`` : "— (not present)"],
          ],
          { align: ["l", "l"] },
        ),
      ].join("\n"),
    );
  }
}
