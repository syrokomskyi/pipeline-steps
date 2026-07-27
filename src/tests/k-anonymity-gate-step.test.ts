import { describe, it, expect } from "vitest";
import { KAnonymityGateStep, DEFAULT_K_MIN, type Stratum } from "../lib/k-anonymity-gate-step.js";
import type { PipelineStepContext } from "@syrokomskyi/pipeline-core";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

function makeCtx(tmpDir: string): PipelineStepContext {
  return {
    state: {},
    currentStepId: null,
    runNamespace: { outputRootDir: "", lockedInputs: {} },
    getPipelineOutputDir: () => tmpDir,
    getStepNumber: () => 1,
    getStepOutputDir: (id: string) => path.join(tmpDir, id),
    getOutputPath: (id: string, n: string) => path.join(tmpDir, id, n),
    getStepArtifactPath: (id: string, a: string) => path.join(tmpDir, id, a),
    ensureOutputDir: async (dir: string) => {
      await fs.mkdir(dir, { recursive: true });
    },
    fileExists: async () => false,
    assertStepArtifactValid: async () => {},
    logStepEvent: async () => {},
  };
}

class TestKAnonStep extends KAnonymityGateStep {
  readonly id = "test-k-anon";
  #strata: Stratum[];
  #mode: "warn" | "enforce";
  #kMin?: number;

  constructor(strata: Stratum[], mode: "warn" | "enforce" = "warn", kMin?: number) {
    super();
    this.#strata = strata;
    this.#mode = mode;
    this.#kMin = kMin;
  }

  protected override getKMin(): number {
    return this.#kMin ?? DEFAULT_K_MIN;
  }

  protected override getMode(): "warn" | "enforce" {
    return this.#mode;
  }

  protected collectStrata(): Stratum[] {
    return this.#strata;
  }

  async run(ctx: PipelineStepContext): Promise<void> {
    await this.enforceKAnonymity(ctx);
  }

  async runCheck(ctx: PipelineStepContext) {
    return this.enforceKAnonymity(ctx);
  }
}

describe("KAnonymityGateStep", () => {
  it("DEFAULT_K_MIN is 5", () => {
    expect(DEFAULT_K_MIN).toBe(5);
  });

  it("passes when all strata meet threshold", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "k-anon-test-"));
    const step = new TestKAnonStep([
      { dimension: "gewerk", key: "sanitaer", count: 10 },
      { dimension: "gewerk", key: "elektro", count: 15 },
    ]);
    const ctx = makeCtx(tmp);
    const result = await step.runCheck(ctx);
    expect(result.passed).toBe(true);
    expect(result.suppressed).toHaveLength(0);
    expect(result.report.total_strata).toBe(2);
    expect(result.report.suppressed_strata).toBe(0);
  });

  it("suppresses strata below threshold in warn mode", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "k-anon-test-"));
    const step = new TestKAnonStep([
      { dimension: "gewerk", key: "sanitaer", count: 10 },
      { dimension: "gewerk", key: "rare", count: 2 },
    ]);
    const ctx = makeCtx(tmp);
    const result = await step.runCheck(ctx);
    expect(result.passed).toBe(false);
    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0]!.key).toBe("rare");
    expect(result.suppressed[0]!.reason).toContain("count 2 < k_min 5");
  });

  it("throws in enforce mode when strata below threshold", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "k-anon-test-"));
    const step = new TestKAnonStep([{ dimension: "gewerk", key: "rare", count: 1 }], "enforce");
    const ctx = makeCtx(tmp);
    await expect(step.runCheck(ctx)).rejects.toThrow("FAILED");
  });

  it("does not throw in warn mode when strata below threshold", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "k-anon-test-"));
    const step = new TestKAnonStep([{ dimension: "gewerk", key: "rare", count: 1 }], "warn");
    const ctx = makeCtx(tmp);
    const result = await step.runCheck(ctx);
    expect(result.passed).toBe(false);
  });

  it("writes report.json to output dir", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "k-anon-test-"));
    const step = new TestKAnonStep([{ dimension: "gewerk", key: "a", count: 10 }]);
    const ctx = makeCtx(tmp);
    const result = await step.runCheck(ctx);
    const reportContent = await fs.readFile(result.reportPath, "utf-8");
    const report = JSON.parse(reportContent);
    expect(report.k_min).toBe(5);
    expect(report.total_strata).toBe(1);
    expect(report.passed).toBe(true);
  });

  it("uses custom kMin when provided", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "k-anon-test-"));
    const step = new TestKAnonStep(
      [
        { dimension: "gewerk", key: "a", count: 10 },
        { dimension: "gewerk", key: "b", count: 7 },
      ],
      "warn",
      12,
    );
    const ctx = makeCtx(tmp);
    const result = await step.runCheck(ctx);
    expect(result.report.k_min).toBe(12);
    expect(result.suppressed).toHaveLength(2);
  });

  it("handles empty strata list", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "k-anon-test-"));
    const step = new TestKAnonStep([]);
    const ctx = makeCtx(tmp);
    const result = await step.runCheck(ctx);
    expect(result.passed).toBe(true);
    expect(result.report.total_strata).toBe(0);
  });
});
