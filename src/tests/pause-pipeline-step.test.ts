import { describe, it, expect } from "vitest";
import { PausePipelineStep } from "../lib/pause-pipeline-step.js";
import { PipelinePauseError } from "@syrokomskyi/pipeline-core";
import type { PipelineStepContext } from "@syrokomskyi/pipeline-core";

function makeCtx(): PipelineStepContext {
  return {
    state: {},
    currentStepId: null,
    runNamespace: { outputRootDir: "", lockedInputs: {} },
    getPipelineOutputDir: () => "/out",
    getStepNumber: () => 1,
    getStepOutputDir: (id: string) => `/out/${id}`,
    getOutputPath: (id: string, n: string) => `/out/${id}/${n}`,
    getStepArtifactPath: (id: string, a: string) => `/out/${id}/${a}`,
    ensureOutputDir: async () => {},
    fileExists: async () => false,
    assertStepArtifactValid: async () => {},
    logStepEvent: async () => {},
  };
}

describe("PausePipelineStep", () => {
  it("throws PipelinePauseError on run", async () => {
    const step = new PausePipelineStep();
    await expect(step.run(makeCtx())).rejects.toThrow(PipelinePauseError);
  });

  it("uses default id and message", () => {
    const step = new PausePipelineStep();
    expect(step.id).toBe("pause-pipeline");
  });

  it("uses custom id", () => {
    const step = new PausePipelineStep({ id: "my-pause" });
    expect(step.id).toBe("my-pause");
  });

  it("uses custom message", async () => {
    const step = new PausePipelineStep({ message: "Custom pause message" });
    await expect(step.run(makeCtx())).rejects.toThrow("Custom pause message");
  });

  it("has retryPolicy 'none'", () => {
    const step = new PausePipelineStep();
    expect(step.retryPolicy).toBe("none");
  });

  it("uses default message", async () => {
    const step = new PausePipelineStep();
    await expect(step.run(makeCtx())).rejects.toThrow("Pipeline paused.");
  });
});
