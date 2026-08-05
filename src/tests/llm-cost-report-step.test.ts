/*
<MODULE_CONTRACT>
  <purpose>Tests for LlmCostReportStep — verifies estimation warning rendering in the Insights section.</purpose>
</MODULE_CONTRACT>
*/

import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LlmCostReportStep } from "../lib/llm-cost-report-step.js";
import type { LlmCostReportStepContext } from "../lib/llm-cost-report-step.js";

class TestCostReportStep extends LlmCostReportStep<LlmCostReportStepContext> {}

const tmpDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function freshTmpRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cost-report-test-"));
  tmpDirs.push(dir);
  return dir;
}

async function makeStepDir(
  tmpRoot: string,
  dirName: string,
  calls: Array<{
    provider: string;
    model: string;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    systemText?: string;
    userText?: string;
    responseText?: string;
  }>,
): Promise<void> {
  const stepDir = path.join(tmpRoot, dirName);
  const aiDir = path.join(stepDir, "AI");
  await fs.mkdir(aiDir, { recursive: true });

  for (let i = 0; i < calls.length; i++) {
    const callDir = path.join(aiDir, `ai-${i + 1}`);
    await fs.mkdir(callDir, { recursive: true });

    const call = calls[i];
    await fs.writeFile(
      path.join(callDir, "llm.md"),
      `- provider: ${call.provider}\n- model: ${call.model}\n`,
    );

    if (call.systemText !== undefined) {
      await fs.writeFile(path.join(callDir, "system.md"), call.systemText);
    }
    if (call.userText !== undefined) {
      await fs.writeFile(path.join(callDir, "user-1.md"), call.userText);
    }
    if (call.responseText !== undefined) {
      await fs.writeFile(path.join(callDir, "response-1.md"), call.responseText);
    }

    if (call.usage) {
      await fs.writeFile(path.join(callDir, "usage.json"), JSON.stringify(call.usage));
    }
  }
}

function makeCtx(tmpRoot: string): LlmCostReportStepContext {
  return {
    state: {},
    currentStepId: null,
    runNamespace: { outputRootDir: tmpRoot, lockedInputs: {} },
    getPipelineOutputDir: () => tmpRoot,
    getStepNumber: () => 99,
    getStepOutputDir: (id: string) => path.join(tmpRoot, id),
    getOutputPath: (id: string, n: string) => path.join(tmpRoot, id, n),
    getStepArtifactPath: (id: string, _a: string) => path.join(tmpRoot, id, "llm-cost-report.md"),
    ensureOutputDir: async (dir: string) => {
      await fs.mkdir(dir, { recursive: true });
    },
    fileExists: async (p: string) => {
      try {
        await fs.access(p);
        return true;
      } catch {
        return false;
      }
    },
    readTextFile: async (p: string) => fs.readFile(p, "utf-8"),
    writeTextFile: async (p: string, content: string) => fs.writeFile(p, content),
    assertStepArtifactValid: async () => {},
    logStepEvent: async () => {},
  };
}

async function runStepAndGetReport(tmpRoot: string): Promise<string> {
  const step = new TestCostReportStep();
  const ctx = makeCtx(tmpRoot);
  await step.run(ctx);
  const reportPath = path.join(tmpRoot, "llm-cost-report", "llm-cost-report.md");
  return fs.readFile(reportPath, "utf-8");
}

describe("LlmCostReportStep — estimation warning", () => {
  it("renders warning when estimated calls exist", async () => {
    const tmpRoot = await freshTmpRoot();
    await makeStepDir(tmpRoot, "10-test-mixed", [
      {
        provider: "openai",
        model: "openai/gpt-5.6-luna",
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        systemText: "system",
        userText: "user",
        responseText: "response",
      },
      {
        provider: "openai",
        model: "openai/gpt-5.6-luna",
        systemText: "some system text here",
        userText: "some user text here",
        responseText: "some response text here",
      },
    ]);

    const report = await runStepAndGetReport(tmpRoot);

    expect(report).toContain("Cost accuracy warning");
    expect(report).toContain("1 of 2 calls (50%) used estimated token counts");
    expect(report).toContain("Affected gogols: test-mixed (1)");
  });

  it("does not render warning when all calls have API usage", async () => {
    const tmpRoot = await freshTmpRoot();
    await makeStepDir(tmpRoot, "20-test-all-api", [
      {
        provider: "openai",
        model: "openai/gpt-5.6-luna",
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        systemText: "system",
        userText: "user",
        responseText: "response",
      },
      {
        provider: "openai",
        model: "openai/gpt-5.6-luna",
        usage: { promptTokens: 200, completionTokens: 80, totalTokens: 280 },
        systemText: "system2",
        userText: "user2",
        responseText: "response2",
      },
    ]);

    const report = await runStepAndGetReport(tmpRoot);

    expect(report).not.toContain("Cost accuracy warning");
  });

  it("does not render warning when no records", async () => {
    const tmpRoot = await freshTmpRoot();

    const report = await runStepAndGetReport(tmpRoot);

    expect(report).toContain("No AI call logs found");
    expect(report).not.toContain("Cost accuracy warning");
  });

  it("dollar range is ±15% of total cost", async () => {
    const tmpRoot = await freshTmpRoot();
    await makeStepDir(tmpRoot, "30-test-dollar-range", [
      {
        provider: "openai",
        model: "openai/gpt-5.6-luna",
        usage: { promptTokens: 1000000, completionTokens: 500000, totalTokens: 1500000 },
        systemText: "system",
        userText: "user",
        responseText: "response",
      },
      {
        provider: "openai",
        model: "openai/gpt-5.6-luna",
        systemText: "a".repeat(1000),
        userText: "b".repeat(1000),
        responseText: "c".repeat(1000),
      },
    ]);

    const report = await runStepAndGetReport(tmpRoot);

    const apiCallCost = (1000000 / 1_000_000) * 0.5 + (500000 / 1_000_000) * 3.0;
    const estimatedCallCost = (500 / 4 / 1_000_000) * 0.5 + (250 / 4 / 1_000_000) * 3.0;
    const totalCost = apiCallCost + estimatedCallCost;
    const expectedDollarRange = totalCost * 0.15;

    const match = report.match(/±\$(\d+\.\d+)/);
    expect(match).not.toBeNull();
    const actualDollarRange = parseFloat(match![1]);
    expect(actualDollarRange).toBeCloseTo(expectedDollarRange, 2);
  });

  it("lists all affected gogols with correct counts", async () => {
    const tmpRoot = await freshTmpRoot();
    await makeStepDir(tmpRoot, "40-test-gogol-a", [
      {
        provider: "openai",
        model: "openai/gpt-5.6-luna",
        systemText: "text",
        userText: "text",
        responseText: "text",
      },
      {
        provider: "openai",
        model: "openai/gpt-5.6-luna",
        systemText: "text",
        userText: "text",
        responseText: "text",
      },
    ]);
    await makeStepDir(tmpRoot, "50-test-gogol-b", [
      {
        provider: "openai",
        model: "openai/gpt-5.6-luna",
        systemText: "text",
        userText: "text",
        responseText: "text",
      },
      {
        provider: "openai",
        model: "openai/gpt-5.6-luna",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        systemText: "text",
        userText: "text",
        responseText: "text",
      },
    ]);

    const report = await runStepAndGetReport(tmpRoot);

    expect(report).toContain("Cost accuracy warning");
    expect(report).toContain("test-gogol-a (2)");
    expect(report).toContain("test-gogol-b (1)");
  });
});
