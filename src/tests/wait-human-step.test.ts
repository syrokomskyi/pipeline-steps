import { expect, test } from "vitest";

import { WaitHumanStep } from "../lib/wait-human-step.js";

test("a human gate declares every artifact it asks the operator to review", async () => {
  const step = new WaitHumanStep({
    id: "approve-dossier",
    reviewedArtifacts: [{ stepId: "editorial-dossier", artifactId: "dossier" }],
    requiredOutputFiles: ["decision.md"],
    message: "Review the dossier.",
  });

  await expect(step.fingerprint.operationInputs({} as never)).resolves.toContainEqual({
    kind: "upstream_artifact",
    stepId: "editorial-dossier",
    artifactId: "dossier",
  });
});

test("accepts a completed frontmatter decision despite instructional placeholder text", async () => {
  const step = new WaitHumanStep({
    id: "approve-inputs",
    requiredOutputFiles: ["decision.md"],
    ensureNonEmptyFiles: ["decision.md"],
    message: "Review the inputs.",
  });
  const files = new Map([
    [
      "/output/decision.md",
      [
        "---",
        "schema: pipeline-human-decision@1",
        "decision: accepted",
        "---",
        "",
        "# Human decision",
        "",
        "Replace `TBD` with the decision and review note.",
      ].join("\n"),
    ],
  ]);
  const context = {
    getStepOutputDir: () => "/output",
    fileExists: async (filePath: string) => files.has(filePath),
    readTextFile: async (filePath: string) => files.get(filePath) ?? "",
    writeTextFile: async (filePath: string, content: string) => {
      files.set(filePath, content);
    },
    ensureOutputDir: async () => undefined,
  };

  await expect(step.run(context as never)).resolves.toBeUndefined();
});
