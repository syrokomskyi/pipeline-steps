/*
<MODULE_CONTRACT>
<purpose>Shared base class for signing and verification steps — provides common step lifecycle methods and abstract contracts.</purpose>
<non-goals>
  <item>Does not implement signing or verification logic — subclasses handle that.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Extracted common patterns from SignSourceStep and VerifyUpstreamStep into a shared base class.</item>
</CHANGE_SUMMARY>
*/

import { PipelineStep } from "@syrokomskyi/pipeline-core";
import type { PipelineStepContext } from "@syrokomskyi/pipeline-core";

/** Context shape required by signature steps — must provide factory gogol helpers. */
export type SignatureStepContext = PipelineStepContext & {
  getGogolOutputDir: (id: string) => string;
  getGogolArtifactPath: (id: string, artifactId: string) => string;
};

export abstract class SignatureStep<
  TContext extends SignatureStepContext = SignatureStepContext,
> extends PipelineStep<TContext> {
  override getPromptFileNames(): string[] {
    return [];
  }

  override getArtifactPath(ctx: TContext, artifactId: string): string {
    return ctx.getGogolArtifactPath(this.id, artifactId);
  }

  override async shouldSkip(ctx: TContext): Promise<boolean> {
    const state = ctx.state as { brief?: { skipGogols?: string[] } };
    return state.brief?.skipGogols?.includes(this.id) ?? false;
  }

  /** This app's ID, e.g. "0-harvest-source". */
  protected abstract getAppId(): string;

  /** Convert an absolute path to a relative one for artifact output. */
  protected abstract toRelativePath(p: string): string;

  /** App version string. Default: "0.1.0". */
  protected getAppVersion(): string {
    return "0.1.0";
  }
}
