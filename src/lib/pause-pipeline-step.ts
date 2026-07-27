/*
<MODULE_CONTRACT>
<purpose>Implements a pipeline step that pauses execution by throwing a pause error.</purpose>
<non-goals>
  <item>Does not handle resuming the pipeline after a pause.</item>
  <item>Does not provide custom retry policies beyond "none".</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial implementation of PausePipelineStep class.</item>
</CHANGE_SUMMARY>
*/

import { PipelinePauseError, PipelineStep } from "@syrokomskyi/pipeline-core";
import type { PipelineStepContext } from "@syrokomskyi/pipeline-core";

export class PausePipelineStep<
  TContext extends PipelineStepContext = PipelineStepContext,
> extends PipelineStep<TContext> {
  readonly id: string;
  override readonly retryPolicy = "none" as const;
  readonly #message: string;

  constructor(options: { id?: string; message?: string } = {}) {
    super();
    this.id = options.id ?? "pause-pipeline";
    this.#message = options.message ?? "Pipeline paused.";
  }

  override async run(ctx: TContext): Promise<void> {
    void ctx;
    throw new PipelinePauseError(this.#message);
  }
}
