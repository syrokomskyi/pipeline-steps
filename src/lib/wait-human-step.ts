/*
<MODULE_CONTRACT>
<purpose>Implements a pipeline step that ensures human intervention by checking for required file outputs and placeholders.</purpose>
<non-goals>
  <item>Does not execute any other pipeline steps.</item>
  <item>Does not modify existing file contents beyond placeholder insertion.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial implementation of WaitHumanStep class for pipeline management.</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";

import { PipelinePauseError, PipelineStep } from "@syrokomskyi/pipeline-core";
import type { PipelineArtifacts, PipelineStepContext } from "@syrokomskyi/pipeline-core";

export type WaitHumanStepMessageFactory = (options: { missingFileNames: string[] }) => string;

export type WaitHumanStepContext = PipelineStepContext & {
  fileExists: (filePath: string) => Promise<boolean>;
  readTextFile: (filePath: string) => Promise<string>;
  writeTextFile: (filePath: string, content: string) => Promise<void>;
};

export type WaitHumanStepOptions = {
  id: string;
  requiredOutputStepId?: string;
  requiredOutputFiles: string[];
  ensureNonEmptyFiles?: string[];
  forbiddenInclude?: {
    sourceFileName: string;
    forbiddenFileName: string;
  };
  message: string | WaitHumanStepMessageFactory;
};

const hasPlaceholder = (content: string): boolean => {
  const lower = content.toLowerCase();
  return lower.includes("tbd") || lower.includes("todo");
};

const inferPathKind = (relativePath: string): "file" | "dir" => {
  return relativePath.endsWith("/") || relativePath.endsWith("\\") ? "dir" : "file";
};

const normalizeRequiredOutputPath = (relativePath: string): string => {
  return relativePath.replace(/[\\/]+$/, "");
};

export class WaitHumanStep<
  TContext extends WaitHumanStepContext = WaitHumanStepContext,
> extends PipelineStep<TContext> {
  readonly id: string;
  readonly requiredOutputStepId?: string;
  readonly requiredOutputFiles: string[];
  readonly ensureNonEmptyFiles?: string[];
  override readonly artifacts: PipelineArtifacts<TContext>;
  override readonly retryPolicy = "none" as const;
  override readonly reusePolicy = "always_run" as const;
  readonly forbiddenInclude?: {
    sourceFileName: string;
    forbiddenFileName: string;
  };
  readonly message: string | WaitHumanStepMessageFactory;
  readonly readmeFileName = "README.md";

  constructor(options: WaitHumanStepOptions) {
    super();
    this.id = options.id;
    this.requiredOutputStepId = options.requiredOutputStepId;
    this.requiredOutputFiles = options.requiredOutputFiles;
    this.ensureNonEmptyFiles = options.ensureNonEmptyFiles;
    this.forbiddenInclude = options.forbiddenInclude;
    this.message = options.message;

    const ownsOutputs = (this.requiredOutputStepId ?? this.id) === this.id;
    if (!ownsOutputs) {
      this.artifacts = {};
      return;
    }

    this.artifacts = Object.fromEntries(
      this.requiredOutputFiles.map((relativePath) => [
        normalizeRequiredOutputPath(relativePath),
        {
          kind: inferPathKind(relativePath),
          relativePath: normalizeRequiredOutputPath(relativePath),
        },
      ]),
    );
  }

  override getPromptFileNames(): string[] {
    return [];
  }

  async run(ctx: TContext): Promise<void> {
    const requiredStepId = this.requiredOutputStepId ?? this.id;
    const outputDir = ctx.getStepOutputDir(requiredStepId);
    const requiredItems = this.requiredOutputFiles.map((relativePath) => ({
      relativePath: normalizeRequiredOutputPath(relativePath),
      absolutePath: path.join(outputDir, normalizeRequiredOutputPath(relativePath)),
      kind: inferPathKind(relativePath),
    }));

    await Promise.all(
      requiredItems.map(async (item) => {
        if (item.kind === "dir") {
          await ctx.ensureOutputDir(item.absolutePath);
          return;
        }

        if (await ctx.fileExists(item.absolutePath)) {
          return;
        }

        await ctx.writeTextFile(item.absolutePath, "TBD");
      }),
    );

    const readinessList = await Promise.all(
      requiredItems.map(async (item) => ({
        ...item,
        exists: await ctx.fileExists(item.absolutePath),
      })),
    );

    const incompleteItems = await Promise.all(
      readinessList.map(async (item) => {
        if (!item.exists || item.kind === "dir") {
          return {
            ...item,
            hasPlaceholder: false,
            isComplete: item.exists,
          };
        }

        const content = await ctx.readTextFile(item.absolutePath);
        const hasFilePlaceholder = hasPlaceholder(content);

        return {
          ...item,
          hasPlaceholder: hasFilePlaceholder,
          isComplete: !hasFilePlaceholder,
        };
      }),
    );

    const missingPaths = incompleteItems.filter((x) => !x.isComplete).map((x) => x.absolutePath);

    const message =
      typeof this.message === "function"
        ? this.message({
            missingFileNames: missingPaths.map((filePath) => path.basename(filePath)),
          })
        : this.message;

    const readmePath = path.join(outputDir, this.readmeFileName);
    const readme = [
      `# ${this.id}`,
      "",
      "Fill the required outputs below and then re-run the pipeline.",
      "",
      "## Required outputs",
      "",
      ...requiredItems.map((item) => `- \`${item.relativePath}\` (${item.kind})`),
      "",
      "## Instruction",
      "",
      message,
      "",
      "## Notes",
      "",
      "- Files are pre-created with `TBD` when missing.",
      "- Replace any `TBD` or `TODO` markers with the final content before re-running the pipeline.",
    ].join("\n");

    await ctx.writeTextFile(readmePath, readme);
    const readmeText = await ctx.readTextFile(readmePath);

    const fail = () => {
      throw new PipelinePauseError([`Pipeline paused by ${this.id}.`, readmeText].join("\n"));
    };

    if (missingPaths.length > 0) {
      fail();
    }

    if (this.ensureNonEmptyFiles && this.ensureNonEmptyFiles.length > 0) {
      const nonEmptyPaths = this.ensureNonEmptyFiles.map((relativePath) =>
        path.join(ctx.getStepOutputDir(requiredStepId), relativePath),
      );

      const contents = await Promise.all(
        nonEmptyPaths.map((absolutePath) => ctx.readTextFile(absolutePath)),
      );
      const emptyPaths = contents
        .map((content, index) => ({
          absolutePath: nonEmptyPaths[index],
          content,
        }))
        .filter((item) => (item.content ?? "").trim().length === 0)
        .map((item) => item.absolutePath)
        .filter((absolutePath): absolutePath is string => Boolean(absolutePath));

      if (emptyPaths.length > 0) {
        fail();
      }
    }

    if (this.forbiddenInclude) {
      const sourcePath = path.join(
        ctx.getStepOutputDir(requiredStepId),
        this.forbiddenInclude.sourceFileName,
      );
      const forbiddenPath = path.join(
        ctx.getStepOutputDir(requiredStepId),
        this.forbiddenInclude.forbiddenFileName,
      );

      const [sourceText, forbiddenText] = await Promise.all([
        ctx.readTextFile(sourcePath),
        ctx.readTextFile(forbiddenPath),
      ]);

      const forbiddenNormalized = forbiddenText.trim();
      if (forbiddenNormalized.length > 0 && sourceText.includes(forbiddenNormalized)) {
        fail();
      }
    }

    console.log(`${this.constructor.name} ${this.id}: checks passed. Continuing...`);
  }
}
