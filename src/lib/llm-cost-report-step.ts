/*
<MODULE_CONTRACT>
<purpose>Abstract step that scans all previous step output directories for AI call logs (AI/ai-*), reads token usage from usage.json (with fallback estimation), computes per-model cost, and writes a markdown cost report.</purpose>
<non-goals>
  <item>Does not make LLM calls — this step only reads existing AI log artifacts.</item>
  <item>Does not modify or move any existing artifacts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial implementation — extracted from app-local LlmCostReportGogol in apps/site.</item>
  <item>Added real OpenRouter pricing for all light-tier and medium-tier models so cost reports reflect actual spend instead of DEFAULT_PRICING fallback.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import path from "node:path";

import { PipelineStep } from "@syrokomskyi/pipeline-core";
import type {
  PipelineStepContext,
  PipelineArtifacts,
  TokenUsage,
} from "@syrokomskyi/pipeline-core";
import { markdownTable } from "markdown-table";

// ─── Pricing ───────────────────────────────────────────────────────────────

type TokenPricing = { inputPer1M: number; outputPer1M: number };
type PerCallPricing = { perCall: number };
type ModelPricing = TokenPricing | PerCallPricing;

const isPerCallPricing = (p: ModelPricing): p is PerCallPricing => "perCall" in p;

const MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI direct models
  "gpt-5.5": { inputPer1M: 5, outputPer1M: 15 },
  "gpt-5-nano": { inputPer1M: 0.5, outputPer1M: 1.5 },
  "gpt-image-1.5": { perCall: 0.04 },
  "gemini-3.1-flash-image-preview": { perCall: 0.03 },
  // OpenRouter-routed models (light tier)
  "openai/gpt-5.6-luna": { inputPer1M: 0.5, outputPer1M: 3.0 },
  "google/gemini-3.6-flash": { inputPer1M: 1.5, outputPer1M: 7.5 },
  "perplexity/sonar": { inputPer1M: 1.0, outputPer1M: 1.0 },
  "z-ai/glm-5.2": { inputPer1M: 0.76, outputPer1M: 2.42 },
  "tencent/hy3": { inputPer1M: 0.132, outputPer1M: 0.528 },
  "meituan/longcat-2.0": { inputPer1M: 0.3, outputPer1M: 1.2 },
  "meta/muse-spark-1.1": { inputPer1M: 1.25, outputPer1M: 4.25 },
  "xiaomi/mimo-v2.5": { inputPer1M: 0.3, outputPer1M: 1.1 },
  // OpenRouter-routed models (medium tier)
  "perplexity/sonar-pro": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "perplexity/sonar-reasoning-pro": { inputPer1M: 2.0, outputPer1M: 8.0 },
};

const DEFAULT_PRICING: ModelPricing = { inputPer1M: 1, outputPer1M: 3 };

const resolvePricing = (model: string): ModelPricing => MODEL_PRICING[model] ?? DEFAULT_PRICING;

// ─── Token estimation ──────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 4;

const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

// ─── Types ─────────────────────────────────────────────────────────────────

interface AiCallRecord {
  gogolId: string;
  gogolNumber: number;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  hasResponse: boolean;
  usageSource: "api" | "estimated";
}

interface CostRow {
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const listSubdirectories = async (dirPath: string): Promise<string[]> => {
  const items = await fs.readdir(dirPath, { withFileTypes: true });
  return items.filter((item) => item.isDirectory()).map((item) => item.name);
};

const listFilesInDir = async (dirPath: string): Promise<string[]> => {
  try {
    const items = await fs.readdir(dirPath, { withFileTypes: true });
    return items.filter((item) => item.isFile()).map((item) => item.name);
  } catch {
    return [];
  }
};

const parseLlmMd = (content: string): { provider: string; model: string } | null => {
  const providerMatch = content.match(/^-\s+provider:\s*(.+)$/m);
  const modelMatch = content.match(/^-\s+model:\s*(.+)$/m);
  if (!providerMatch || !modelMatch) {
    return null;
  }
  return {
    provider: providerMatch[1].trim(),
    model: modelMatch[1].trim(),
  };
};

const extractStepNameFromDirName = (dirName: string): string => {
  const match = dirName.match(/^\d+-(.*)$/);
  return match ? match[1] : dirName;
};

const extractStepNumberFromDirName = (dirName: string): number => {
  const match = dirName.match(/^(\d+)-/);
  return match ? parseInt(match[1], 10) : 0;
};

const readAllTextFiles = async (
  readTextFile: (filePath: string) => Promise<string>,
  dirPath: string,
  fileNames: string[],
): Promise<string> => {
  const contents: string[] = [];
  for (const fileName of fileNames) {
    try {
      contents.push(await readTextFile(path.join(dirPath, fileName)));
    } catch {
      // File might not exist
    }
  }
  return contents.join("\n\n");
};

const computeCallCost = (model: string, inputTokens: number, outputTokens: number): number => {
  const pricing = resolvePricing(model);
  if (isPerCallPricing(pricing)) {
    return pricing.perCall;
  }
  return (
    (inputTokens / 1_000_000) * pricing.inputPer1M +
    (outputTokens / 1_000_000) * pricing.outputPer1M
  );
};

const formatCurrency = (value: number): string => {
  if (value < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  return `$${value.toFixed(2)}`;
};

const formatTokens = (value: number): string => {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return String(value);
};

// ─── Context shape ─────────────────────────────────────────────────────────

export type LlmCostReportStepContext = PipelineStepContext & {
  readTextFile: (filePath: string) => Promise<string>;
  writeTextFile: (filePath: string, content: string) => Promise<void>;
};

// ─── Step ──────────────────────────────────────────────────────────────────

export abstract class LlmCostReportStep<
  TContext extends LlmCostReportStepContext = LlmCostReportStepContext,
> extends PipelineStep<TContext> {
  override readonly id = "llm-cost-report";

  override readonly artifacts: PipelineArtifacts<TContext> = {
    report: {
      kind: "file",
      relativePath: "llm-cost-report.md",
      validate: async ({ ctx, absolutePath }) => {
        const text = (await ctx.readTextFile(absolutePath)).trim();
        if (text.length < 100) {
          throw new Error(`LLM cost report is too short (${text.length} chars, expected >= 100).`);
        }
      },
    },
  };

  override async validateBeforeStart(_ctx: TContext): Promise<void> {
    return;
  }

  override async run(ctx: TContext): Promise<void> {
    const outputPath = this.getArtifactPath(ctx, "report");

    if (await ctx.fileExists(outputPath)) {
      return;
    }

    const outputDir = ctx.getStepOutputDir(this.id);
    await ctx.ensureOutputDir(outputDir);

    const outputRoot = path.dirname(outputDir);
    const records = await this.collectAiCallRecords(ctx, outputRoot, path.basename(outputDir));

    const report = this.buildReport(records);
    await ctx.writeTextFile(outputPath, report);
  }

  private async collectAiCallRecords(
    ctx: TContext,
    outputRoot: string,
    ownDirName: string,
  ): Promise<AiCallRecord[]> {
    const stepDirs = await listSubdirectories(outputRoot);
    const records: AiCallRecord[] = [];

    for (const stepDirName of stepDirs) {
      if (stepDirName === ownDirName || stepDirName === "_guide") {
        continue;
      }

      const stepDirPath = path.join(outputRoot, stepDirName);
      const aiDir = path.join(stepDirPath, "AI");

      let aiSubDirs: string[];
      try {
        aiSubDirs = await listSubdirectories(aiDir);
      } catch {
        continue;
      }

      const gogolId = extractStepNameFromDirName(stepDirName);
      const gogolNumber = extractStepNumberFromDirName(stepDirName);

      for (const aiSubDir of aiSubDirs) {
        const callDir = path.join(aiDir, aiSubDir);
        const record = await this.parseAiCallDir(ctx, callDir, gogolId, gogolNumber);
        if (record) {
          records.push(record);
        }
      }
    }

    return records;
  }

  private async parseAiCallDir(
    ctx: TContext,
    callDir: string,
    gogolId: string,
    gogolNumber: number,
  ): Promise<AiCallRecord | null> {
    let llmContent: string;
    try {
      llmContent = await ctx.readTextFile(path.join(callDir, "llm.md"));
    } catch {
      return null;
    }

    const parsed = parseLlmMd(llmContent);
    if (!parsed) {
      return null;
    }

    const allFiles = await listFilesInDir(callDir);
    const systemFiles = allFiles.filter((f) => f === "system.md");
    const userFiles = allFiles.filter((f) => /^user-\d+\.md$/.test(f)).sort();
    const responseFiles = allFiles.filter((f) => /^response-.*\.md$/.test(f)).sort();

    let inputTokens: number;
    let outputTokens: number;
    let usageSource: "api" | "estimated" = "estimated";

    try {
      const usageContent = await ctx.readTextFile(path.join(callDir, "usage.json"));
      const usage = JSON.parse(usageContent) as TokenUsage;
      inputTokens = usage.promptTokens ?? 0;
      outputTokens = usage.completionTokens ?? 0;
      usageSource = "api";
    } catch {
      const inputText = await readAllTextFiles(ctx.readTextFile, callDir, [
        ...systemFiles,
        ...userFiles,
      ]);
      const outputText = await readAllTextFiles(ctx.readTextFile, callDir, responseFiles);
      inputTokens = estimateTokens(inputText);
      outputTokens = estimateTokens(outputText);
    }

    const cost = computeCallCost(parsed.model, inputTokens, outputTokens);

    return {
      gogolId,
      gogolNumber,
      provider: parsed.provider,
      model: parsed.model,
      inputTokens,
      outputTokens,
      cost,
      hasResponse: responseFiles.length > 0,
      usageSource,
    };
  }

  private buildReport(records: AiCallRecord[]): string {
    if (records.length === 0) {
      return [
        "# LLM Cost Report",
        "",
        "> No AI call logs found in any step output directory.",
        "",
      ].join("\n");
    }

    const grouped = new Map<string, CostRow>();
    for (const record of records) {
      const key = `${record.provider}\u0000${record.model}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.calls += 1;
        existing.inputTokens += record.inputTokens;
        existing.outputTokens += record.outputTokens;
        existing.cost += record.cost;
      } else {
        grouped.set(key, {
          provider: record.provider,
          model: record.model,
          calls: 1,
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          cost: record.cost,
        });
      }
    }

    const rows = [...grouped.values()].sort((a, b) => b.cost - a.cost);
    const totalCost = rows.reduce((sum, r) => sum + r.cost, 0);
    const totalCalls = rows.reduce((sum, r) => sum + r.calls, 0);
    const totalInputTokens = rows.reduce((sum, r) => sum + r.inputTokens, 0);
    const totalOutputTokens = rows.reduce((sum, r) => sum + r.outputTokens, 0);

    const costTable: string[][] = [
      [
        "\u041f\u043e\u0441\u0442\u0430\u0432\u0449\u0438\u043a",
        "\u041c\u043e\u0434\u0435\u043b\u044c",
        "\u0412\u044b\u0437\u043e\u0432\u044b",
        "\u0412\u0445\u043e\u0434\u044f\u0449\u0438\u0435 \u0442\u043e\u043a\u0435\u043d\u044b",
        "\u0418\u0441\u0445\u043e\u0434\u044f\u0449\u0438\u0435 \u0442\u043e\u043a\u0435\u043d\u044b",
        "\u0421\u0442\u043e\u0438\u043c\u043e\u0441\u0442\u044c",
      ],
      ...rows.map((r) => [
        r.provider,
        r.model,
        String(r.calls),
        formatTokens(r.inputTokens),
        formatTokens(r.outputTokens),
        formatCurrency(r.cost),
      ]),
      [
        "**\u0418\u0442\u043e\u0433\u043e**",
        "",
        `**${totalCalls}**`,
        `**${formatTokens(totalInputTokens)}**`,
        `**${formatTokens(totalOutputTokens)}**`,
        `**${formatCurrency(totalCost)}**`,
      ],
    ];

    const lines: string[] = [
      "# LLM Cost Report",
      "",
      `Generated: ${new Date().toISOString()}`,
      "",
      "## Cost by Provider + Model",
      "",
      markdownTable(costTable, { align: ["l", "l", "r", "r", "r", "r"] }),
      "",
    ];

    lines.push(...this.buildPerGogolSection(records));
    lines.push(
      ...this.buildInsightsSection(records, totalCalls, totalInputTokens, totalOutputTokens),
    );

    return lines.join("\n");
  }

  private buildPerGogolSection(records: AiCallRecord[]): string[] {
    const byGogol = new Map<
      string,
      { gogolId: string; gogolNumber: number; calls: number; cost: number }
    >();
    for (const r of records) {
      const existing = byGogol.get(r.gogolId);
      if (existing) {
        existing.calls += 1;
        existing.cost += r.cost;
      } else {
        byGogol.set(r.gogolId, {
          gogolId: r.gogolId,
          gogolNumber: r.gogolNumber,
          calls: 1,
          cost: r.cost,
        });
      }
    }

    const gogolRows = [...byGogol.values()].sort((a, b) => b.cost - a.cost);

    const gogolTable: string[][] = [
      [
        "#",
        "Gogol",
        "\u0412\u044b\u0437\u043e\u0432\u044b",
        "\u0421\u0442\u043e\u0438\u043c\u043e\u0441\u0442\u044c",
      ],
      ...gogolRows.map((r) => [
        String(r.gogolNumber),
        r.gogolId,
        String(r.calls),
        formatCurrency(r.cost),
      ]),
    ];

    return ["## Cost by Gogol", "", markdownTable(gogolTable, { align: ["r", "l", "r", "r"] }), ""];
  }

  private buildInsightsSection(
    records: AiCallRecord[],
    totalCalls: number,
    totalInputTokens: number,
    totalOutputTokens: number,
  ): string[] {
    const failedCalls = records.filter((r) => !r.hasResponse);
    const apiCalls = records.filter((r) => r.usageSource === "api").length;
    const estimatedCalls = records.filter((r) => r.usageSource === "estimated").length;
    const avgInput = totalCalls > 0 ? Math.round(totalInputTokens / totalCalls) : 0;
    const avgOutput = totalCalls > 0 ? Math.round(totalOutputTokens / totalCalls) : 0;

    const byInputSize = [...records].sort((a, b) => b.inputTokens - a.inputTokens).slice(0, 5);

    const topPromptsTable: string[][] = [
      ["Gogol", "Model", "Input Tokens"],
      ...byInputSize.map((r) => [r.gogolId, r.model, formatTokens(r.inputTokens)]),
    ];

    const lines: string[] = [
      "## Insights",
      "",
      `- **Total LLM calls:** ${totalCalls}`,
      `- **Calls with API usage data:** ${apiCalls}`,
      `- **Calls with estimated tokens:** ${estimatedCalls}`,
      `- **Total input tokens:** ${formatTokens(totalInputTokens)}`,
      `- **Total output tokens:** ${formatTokens(totalOutputTokens)}`,
      `- **Average input tokens per call:** ${formatTokens(avgInput)}`,
      `- **Average output tokens per call:** ${formatTokens(avgOutput)}`,
      `- **Calls without response (potential failures):** ${failedCalls.length}`,
      "",
      "### Top 5 Largest Prompts",
      "",
      markdownTable(topPromptsTable, { align: ["l", "l", "r"] }),
      "",
      "### Notes",
      "",
      "- Token counts come from `usage.json` (API response usage) when available, otherwise estimated from text (~4 chars/token).",
      "- Pricing is based on a configurable table inside `LlmCostReportStep`.",
      "- Image generation calls (gpt-image-1.5, gemini image models) use per-call pricing, not token-based pricing.",
      "",
    ];

    return lines;
  }
}
