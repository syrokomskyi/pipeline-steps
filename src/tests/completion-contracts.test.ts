import { expect, test } from "vitest";

import { assertPipelineExternalEffectReceipt, assertPipelineHumanDecision } from "../index.js";

const fingerprint = "a".repeat(64);

test("a human decision is accepted only for its exact reviewed fingerprint", () => {
  expect(() => assertPipelineHumanDecision({ schema: "pipeline-human-decision@1", reviewedFingerprint: fingerprint, decision: "accepted" }, fingerprint)).not.toThrow();
  expect(() => assertPipelineHumanDecision({ schema: "pipeline-human-decision@1", reviewedFingerprint: "b".repeat(64), decision: "accepted" }, fingerprint)).toThrow("stale");
});

test("an external receipt requires both the current idempotency key and an external id", () => {
  expect(() => assertPipelineExternalEffectReceipt({ schema: "pipeline-external-effect-receipt@1", idempotencyKey: fingerprint, externalId: "remote-42" }, fingerprint)).not.toThrow();
  expect(() => assertPipelineExternalEffectReceipt({ schema: "pipeline-external-effect-receipt@1", idempotencyKey: fingerprint, externalId: "" }, fingerprint)).toThrow("does not match");
});
