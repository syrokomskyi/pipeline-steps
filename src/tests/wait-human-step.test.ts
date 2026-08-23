import { expect, test } from "vitest";

import { WaitHumanStep } from "../lib/wait-human-step.js";

test("a human gate fingerprints every artifact it claims to review", async () => {
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
