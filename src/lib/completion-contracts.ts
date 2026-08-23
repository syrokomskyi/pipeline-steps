/*
<MODULE_CONTRACT>
<purpose>Define versioned human-decision and external-effect completion proofs.</purpose>
<non-goals>
  <item>Do not perform an external effect or choose a human decision.</item>
  <item>Do not determine artifact reuse independently of pipeline-core.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0094: Add reusable completion proof contracts for human and effectful steps.</item>
</CHANGE_SUMMARY>
*/

export type PipelineHumanDecisionV1 = {
  schema: "pipeline-human-decision@1";
  reviewedFingerprint: string;
  decision: string;
};

export type PipelineExternalEffectReceiptV1 = {
  schema: "pipeline-external-effect-receipt@1";
  idempotencyKey: string;
  externalId: string;
};

const isSha256 = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export const assertPipelineHumanDecision = (
  value: unknown,
  expectedFingerprint: string,
): asserts value is PipelineHumanDecisionV1 => {
  const candidate = value as Partial<PipelineHumanDecisionV1> | null;
  if (
    !candidate ||
    candidate.schema !== "pipeline-human-decision@1" ||
    !isSha256(candidate.reviewedFingerprint) ||
    candidate.reviewedFingerprint !== expectedFingerprint ||
    typeof candidate.decision !== "string" ||
    candidate.decision.trim().length === 0
  ) {
    throw new Error("Human decision is missing or stale for the reviewed fingerprint");
  }
};

export const assertPipelineExternalEffectReceipt = (
  value: unknown,
  expectedIdempotencyKey: string,
): asserts value is PipelineExternalEffectReceiptV1 => {
  const candidate = value as Partial<PipelineExternalEffectReceiptV1> | null;
  if (
    !candidate ||
    candidate.schema !== "pipeline-external-effect-receipt@1" ||
    !isSha256(candidate.idempotencyKey) ||
    candidate.idempotencyKey !== expectedIdempotencyKey ||
    typeof candidate.externalId !== "string" ||
    candidate.externalId.trim().length === 0
  ) {
    throw new Error("External effect receipt does not match the current idempotency key");
  }
};
