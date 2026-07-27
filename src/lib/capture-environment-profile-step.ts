/*
<MODULE_CONTRACT>
<purpose>Abstract step that captures system environment profile for audit reproducibility and transparency.</purpose>
<non-goals>
  <item>Do not modify system state.</item>
  <item>Do not perform network speed tests.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial implementation — extracted from duplicated CaptureEnvironmentProfileGogol in 4-audit-lighthouse and 5-audit-axe.</item>
  <item>Add typed EnvironmentProfile interface to eliminate as-casts in formatMarkdown.</item>
  <item>Replace shouldSkip as-cast with abstract getSkipGogols method.</item>
</CHANGE_SUMMARY>
*/

import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import si from "systeminformation";
import { PipelineStep } from "@syrokomskyi/pipeline-core";
import type { PipelineStepContext } from "@syrokomskyi/pipeline-core";

type ToolVersion = {
  name: string;
  version: string | null;
  error?: string;
};

type EnvironmentProfile = {
  capturedAt: string;
  nodejs: { version: string; arch: string; platform: string; execPath: string };
  system: {
    platform: string;
    release: string;
    arch: string;
    cpus: number;
    totalMemory: number;
    freeMemory: number;
  };
  hardware: {
    cpu: {
      manufacturer: string;
      brand: string;
      speed: number;
      cores: number;
      physicalCores: number;
      processors: number;
    };
    memory: {
      total: number;
      totalFormatted: string;
      free: number;
      freeFormatted: string;
      used: number;
      usedFormatted: string;
    };
  };
  os: {
    platform: string;
    distro: string;
    release: string;
    codename: string;
    kernel: string;
    arch: string;
    hostname: string;
  };
  tools: ToolVersion[];
  brief: Record<string, unknown>;
};

/** Context shape required by CaptureEnvironmentProfileStep. */
export type CaptureEnvironmentProfileStepContext = PipelineStepContext & {
  getGogolOutputDir: (id: string) => string;
  writeTextFile: (filePath: string, content: string) => Promise<void>;
};

/**
 * CaptureEnvironmentProfileStep — abstract step that captures OS, Node,
 * hardware, and tool version information into JSON and Markdown artifacts
 * for audit reproducibility.
 *
 * Each audit app (4-audit-lighthouse, 5-audit-axe) had a 240+ line copy
 * that differed only in which brief fields were included in the profile
 * snapshot. This base class owns the entire workflow; subclasses provide
 * app-specific brief fields via `getBriefSnapshot()`.
 *
 * Usage:
 *   class CaptureEnvironmentProfileGogol extends CaptureEnvironmentProfileStep<PipelineContext> {
 *     override readonly id = "capture-environment-profile";
 *     protected override getBriefSnapshot(ctx) {
 *       return { sourceToken: ctx.state.brief.sourceToken, ... };
 *     }
 *   }
 */
export abstract class CaptureEnvironmentProfileStep<
  TContext extends CaptureEnvironmentProfileStepContext = CaptureEnvironmentProfileStepContext,
> extends PipelineStep<TContext> {
  override getPromptFileNames(): string[] {
    return [];
  }

  override getArtifactPath(ctx: TContext, artifactId: string): string {
    return path.join(ctx.getGogolOutputDir(this.id), artifactId);
  }

  override async shouldSkip(ctx: TContext): Promise<boolean> {
    const skipGogols = this.getSkipGogols(ctx);
    if (skipGogols?.includes(this.id)) return true;
    const resultsPath = path.join(ctx.getGogolOutputDir(this.id), "environment-profile.json");
    try {
      await fsp.access(resultsPath);
      console.log(`[${this.id}] Results already exist, skipping.`);
      return true;
    } catch {
      return false;
    }
  }

  /** Subclass provides app-specific brief fields for the profile snapshot. */
  protected abstract getBriefSnapshot(ctx: TContext): Record<string, unknown>;

  /** Subclass provides the skipGogols list from its brief, or undefined if not supported. */
  protected abstract getSkipGogols(ctx: TContext): string[] | undefined;

  override async run(ctx: TContext): Promise<void> {
    console.log(`[${this.id}] Collecting system information...`);

    const [cpu, mem, osInfo] = await Promise.all([si.cpu(), si.mem(), si.osInfo()]);
    const toolVersions = await this.getToolVersions();

    const profile: EnvironmentProfile = {
      capturedAt: new Date().toISOString(),
      nodejs: {
        version: process.version,
        arch: process.arch,
        platform: process.platform,
        execPath: process.execPath,
      },
      system: {
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        cpus: os.cpus().length,
        totalMemory: os.totalmem(),
        freeMemory: os.freemem(),
      },
      hardware: {
        cpu: {
          manufacturer: cpu.manufacturer,
          brand: cpu.brand,
          speed: cpu.speed,
          cores: cpu.cores,
          physicalCores: cpu.physicalCores,
          processors: cpu.processors,
        },
        memory: {
          total: mem.total,
          totalFormatted: this.formatBytes(mem.total),
          free: mem.free,
          freeFormatted: this.formatBytes(mem.free),
          used: mem.used,
          usedFormatted: this.formatBytes(mem.used),
        },
      },
      os: {
        platform: osInfo.platform,
        distro: osInfo.distro,
        release: osInfo.release,
        codename: osInfo.codename,
        kernel: osInfo.kernel,
        arch: osInfo.arch,
        hostname: osInfo.hostname,
      },
      tools: toolVersions,
      brief: this.getBriefSnapshot(ctx),
    };

    const outDir = ctx.getGogolOutputDir(this.id);

    await ctx.writeTextFile(
      path.join(outDir, "environment-profile.json"),
      JSON.stringify(profile, null, 2),
    );

    await ctx.writeTextFile(
      path.join(outDir, "environment-profile.md"),
      this.formatMarkdown(profile),
    );

    console.log(
      `[${this.id}] Done. CPU: ${profile.hardware.cpu.brand}, Memory: ${profile.hardware.memory.totalFormatted}`,
    );
  }

  private async getToolVersions(): Promise<ToolVersion[]> {
    const tools: ToolVersion[] = [];

    try {
      const lighthouse = await import("lighthouse");
      tools.push({
        name: "lighthouse",
        version: (lighthouse as { default?: { version?: string } }).default?.version ?? null,
      });
    } catch (_e) {
      tools.push({ name: "lighthouse", version: null, error: "Not installed or import failed" });
    }

    try {
      const chromeLauncher = await import("chrome-launcher");
      tools.push({
        name: "chrome-launcher",
        version: (chromeLauncher as { Launcher?: { getInstallations?: unknown } }).Launcher
          ? "installed"
          : null,
      });
    } catch (_e) {
      tools.push({ name: "chrome-launcher", version: null, error: "Not installed" });
    }

    try {
      const playwright = await import("playwright");
      tools.push({
        name: "playwright",
        version:
          (
            playwright as { chromium?: { browserType?: { version?: () => string } } }
          ).chromium?.browserType?.version?.() ?? "installed",
      });
    } catch (_e) {
      tools.push({ name: "playwright", version: null, error: "Not installed" });
    }

    try {
      const axeCore = await import("axe-core");
      tools.push({
        name: "axe-core",
        version: (axeCore as { default?: { version?: string } }).default?.version ?? null,
      });
    } catch (_e) {
      tools.push({ name: "axe-core", version: null, error: "Not installed" });
    }

    try {
      const siModule = await import("systeminformation");
      tools.push({
        name: "systeminformation",
        version: (siModule as { version?: () => string }).version?.() ?? "installed",
      });
    } catch (_e) {
      tools.push({ name: "systeminformation", version: null, error: "Not installed" });
    }

    return tools;
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  }

  private formatMarkdown(profile: EnvironmentProfile): string {
    const briefEntries = Object.entries(profile.brief);

    return [
      "# Environment Profile",
      "",
      `**Captured:** ${profile.capturedAt}  `,
      "",
      "## System",
      "",
      `- **Platform:** ${profile.system.platform}  `,
      `- **OS:** ${profile.os.distro} ${profile.os.release}  `,
      `- **Kernel:** ${profile.os.kernel}  `,
      `- **Architecture:** ${profile.system.arch}  `,
      `- **Hostname:** ${profile.os.hostname}  `,
      "",
      "## Hardware",
      "",
      `- **CPU:** ${profile.hardware.cpu.brand}  `,
      `- **CPU Cores:** ${profile.hardware.cpu.cores} logical / ${profile.hardware.cpu.physicalCores} physical  `,
      `- **CPU Speed:** ${profile.hardware.cpu.speed} GHz  `,
      `- **Memory:** ${profile.hardware.memory.totalFormatted} total / ${profile.hardware.memory.freeFormatted} free  `,
      "",
      "## Node.js",
      "",
      `- **Version:** ${profile.nodejs.version}  `,
      `- **Architecture:** ${profile.nodejs.arch}  `,
      `- **Platform:** ${profile.nodejs.platform}  `,
      "",
      "## Tools",
      "",
      ...profile.tools.map(
        (t) => `- **${t.name}:** ${t.version ?? "N/A"}${t.error ? ` (${t.error})` : ""}  `,
      ),
      "",
      "## Audit Configuration",
      "",
      ...briefEntries.map(([key, value]) => `- **${key}:** ${String(value)}  `),
    ].join("\n");
  }
}
