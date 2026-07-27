# @syrokomskyi/pipeline-steps

Reusable abstract **step base classes** extracted from recurring patterns across the pipeline apps. Each class encapsulates one cross-cutting concern (rate limiting, browser pooling, cross-DB reads, DSGVO k-anonymity, human pauses) so consumer gogols can focus on business logic.

> **When not to use:** if a step does a simple, self-contained thing (e.g. `SetupAuditDbGogol`), keep extending your app's local `Gogol` class. These base classes are for the gnarly, duplicate-on-each-app patterns.

---

## Dispatch table — which base class do I need?

| Your gogol… | Use | Why |
| --- | --- | --- |
| …calls a 3rd-party HTTP API with per-host / per-key rate limits | **`RateLimitedHttpStep`** | token-bucket + circuit breaker + retry wrapped in one `this.schedule(fn)` |
| …drives a headless browser (Playwright) | **`PlaywrightPooledStep`** | concurrency-gated `withBrowser` / `withPage`; browser is a peer dep |
| …reads an upstream pipeline's SQLite DB (`*.db`) read-only | **`CrossDbReadOnlyStep`** | `{ readonly: true }` + WAL + FK pragmas + streaming SHA-256 + auto-close |
| …publishes data derived from human subjects (DSGVO) | **`KAnonymityGateStep`** | `enforceKAnonymity(ctx)` — warn or enforce with per-stratum report.json |
| …signs a source DB file hash with the device ed25519 key | **`SignSourceStep`** | loads signing key from env, hashes DB, writes manifest + summary artifacts |
| …verifies upstream device signatures before consuming DBs | **`VerifyUpstreamStep`** | loads transparency keys, enumerates device folders, verifies manifests + hashes |
| …needs a synchronous manual signoff (codebook, Beirat) | **`WaitHumanStep`** | polls for an approval artifact, writes a pause marker |
| …stops the pipeline unconditionally until a human resumes it | **`PausePipelineStep`** | thin wrapper; no side effects beyond the pause marker |
| …captures OS / Node / hardware / tool versions for audit reproducibility | **`CaptureEnvironmentProfileStep`** | system info via `systeminformation`, tool version probing, JSON + Markdown artifacts |
| …generates an audit snapshot report with per-tool stats and DB hashes | **`SummarizeAuditStep<TStats>`** | generic over tool-specific stats; snapshot JSON + Markdown with SHA-256 integrity |

---

## `CrossDbReadOnlyStep` — two patterns

The base class exposes `this.withReadOnlyDbs(fn)` + `this.openReadOnly(name, path)`. **Prefer the return-value form:**

```ts
// GOOD — return-value form. Type flows naturally.
const scratch = await this.withReadOnlyDbs(async () => {
  const scoresDb = this.openReadOnly('scoresDb', scoresPath);
  const rows = scoresDb.prepare('SELECT ...').all();
  return { rows };
});
// scratch.rows is typed; scoresDb is already closed.
```

**Avoid** capturing into an outer `let` from inside the async callback — TypeScript can't narrow it after the `await`, and you'll end up casting:

```ts
// BAD — forces `as unknown as ... | null` casts later.
let scratch: Scratch | null = null;
await this.withReadOnlyDbs(async () => {
  scratch = { ... };
});
```

`openReadOnly` throws at runtime if called outside `withReadOnlyDbs` — prevents DB leaks.

After the callback returns, `this.inputHashes` contains SHA-256 hex of each opened file (streaming, safe for multi-GB DBs). Feed these to your MANIFEST or `pipeline_inputs` row for reproducibility.

---

## `RateLimitedHttpStep` — usage

Concrete class provides `getRateLimitOptions()`. The base wraps every call to `this.schedule(fn)` with the gate → bucket → breaker → retry chain from `@syrokomskyi/rate-limit`. Pass `onEvent` in the options to receive a unified event stream (gate-acquired, gate-released, bucket-acquired, bucket-queued, retry, breaker-state) from all sub-modules.

```ts
export class FetchHdriGogol extends RateLimitedHttpStep<PipelineContext> {
  override readonly id = 'fetch-hdri';
  override getRateLimitOptions() {
    return { tokensPerInterval: 10, intervalMs: 1000, maxConcurrent: 4 };
  }
  override async run(ctx: PipelineContext) {
    for (const site of ctx.state.sites) {
      await this.schedule(() => fetch(site.url));
    }
  }
}
```

Inspect at runtime: `this.inFlight()`, `this.queueDepth()`.

---

## `PlaywrightPooledStep` — usage

`playwright` is a **peer dependency** — loaded via dynamic import so this package stays install-light. If the consuming app hasn't installed it, the step fails loudly at runtime (not at type-check).

```ts
await this.withPage(async (page) => {
  await page.goto(url);
  return await page.title();
});
```

Global concurrency is governed by a single `ConcurrencyGate`; override `getMaxConcurrentPages()` to change it.

---

## `KAnonymityGateStep` — usage

Override `collectStrata(ctx)` to return a list of `Stratum` objects (groups of records whose publication would identify fewer than K_MIN people). `enforceKAnonymity(ctx)` returns `KAnonymityOutcome` — a report plus `passedStrataKeys` and `failedStrataKeys`. Behavior depends on mode:

- `warn` (default): logs failures, returns the outcome; consumer code must filter suppressed strata out of the publication payload.
- `enforce`: throws on any failing stratum — pipeline halts.

Default `K_MIN = 5` (exported as `DEFAULT_K_MIN`). Always writes `report.json` to `getOutputDir(ctx)` for audit.

---

## `SignSourceStep` — usage

Subclass and implement the abstract methods to provide app-specific config. The base class owns the entire signing workflow (key loading, DB hashing, manifest creation, artifact writing).

```ts
export class SignSourceGogol extends SignSourceStep<PipelineContext> {
  override readonly id = 'sign-source';
  override readonly guide = { ... };

  protected override getAppId() { return '0-harvest-source'; }
  protected override getDbPath(ctx) { return getCoreDbPath(year); }
  protected override getSourceToken(ctx) { return ctx.state.brief.sourceToken; }
  protected override toRelativePath(p) { return toFactoryRelativePath(p); }
  protected override getLogLabel() { return 'core.db'; }

  // Optional overrides:
  // protected override getDeviceId(ctx, signingKey) { return ctx.state.deviceId; }
  // protected override getExtraMdRows(ctx, dbPath) { return [['DB file', dbPath]]; }
  // protected override onSigned(ctx, summary) { ctx.state.contentHash = summary.contentHash; }
}
```

Artifacts written: `source-signature.json`, `sign-source-summary.json`, `sign-source-summary.md`.

---

## `VerifyUpstreamStep` — usage

Subclass and implement abstract methods. The base class owns the full verification loop (key loading, device enumeration, manifest finding, signature verification, hash re-computation, summary writing).

```ts
export class VerifyUpstreamGogol extends VerifyUpstreamStep<PipelineContext> {
  override readonly id = 'verify-upstream';
  override readonly guide = { ... };

  protected override getAppId() { return '1-register-businesses'; }
  protected override getExpectedUpstreamAppId() { return '0-harvest-source'; }
  protected override getUpstreamRoot(ctx) { return ctx.state.upstreamHarvestOutputRoot; }
  protected override getDbFilenames(ctx) { return [`core_${ctx.state.year}.db`]; }
  protected override getYear(ctx) { return ctx.state.year; }
  protected override getDeviceId(ctx) { return ctx.state.deviceId; }
  protected override getSourceToken(ctx) { return ctx.state.sourceToken; }
  protected override toRelativePath(p) { return toFactoryRelativePath(p); }
}
```

Supports multiple DB filenames per device (e.g. `pages-YYYY-h1.db`, `pages-YYYY-h2.db`). Throws if any verification fails.

Artifacts written: `verify-upstream-summary.json`, `verify-upstream-summary.md`.

---

## `CaptureEnvironmentProfileStep` — usage

Subclass and override `getBriefSnapshot(ctx)` to provide app-specific brief fields, and `getSkipGogols(ctx)` to wire the skip list. The base class owns the entire workflow: system info collection, tool version probing, JSON + Markdown artifact writing, and skip-if-exists logic.

```ts
export class CaptureEnvironmentProfileGogol extends CaptureEnvironmentProfileStep<PipelineContext> {
  override readonly id = 'capture-environment-profile';

  protected override getBriefSnapshot(ctx: PipelineContext): Record<string, unknown> {
    return { sourceToken: ctx.state.brief.sourceToken, concurrency: ctx.state.brief.concurrency };
  }

  protected override getSkipGogols(ctx: PipelineContext): string[] | undefined {
    return ctx.state.brief.skipGogols;
  }
}
```

Artifacts written: `environment-profile.json`, `environment-profile.md`.

---

## `SummarizeAuditStep<TStats>` — usage

Generic over `TStats` — the tool-specific stats type returned by `queryToolStats`. Subclass implements abstract methods for DB access, stats query, and formatting. The base class owns snapshot creation, SHA-256 hashing, DB provenance, and JSON + Markdown report writing.

```ts
export class SummarizeAuditGogol extends SummarizeAuditStep<PipelineContext, LighthouseAverages> {
  override readonly id = 'summarize-audit';

  protected override getAuditsDbPath(year: number) { return getAuditsDbPath(year); }
  protected override getAuditsDbName(year: number) { return getAuditsDbName(year); }
  protected override openAuditsDb(dbPath: string) { return openAuditsDb(dbPath); }
  protected override getYear(ctx: PipelineContext) { return parseSourceToken(ctx.state.brief.sourceToken).year; }
  protected override getRegistryDbPath(ctx: PipelineContext) { return ctx.state.resolvedRegistryDbPath; }

  protected override queryToolStats(db: Database.Database): LighthouseAverages { ... }
  protected override getToolStatsSnapshot(stats: LighthouseAverages) { return { lighthouseAverages: stats }; }
  protected override formatToolStatsMarkdown(stats: LighthouseAverages) { ... }
}
```

Artifacts written: `audit-snapshot.json`, `audit-snapshot.md`.

---

## Adding a new step base class

1. Extract only when the **same** 15+ lines appear in ≥ 2 apps.
2. Put it in `src/lib/<name>-step.ts`, export from `src/index.ts`.
3. Keep external deps as peer deps; consume via `createRequire` (CJS) or dynamic `import('…' as string)` (ESM) so install stays light.
4. Document the dispatch row in this README.
5. Migrate the consumer gogols in the same PR — no orphan base classes.

---

## Video extraction utilities

`src/lib/video-extraction.ts` exports reusable helper functions (not a step base class) for extracting text from video sources via the `yt-dlp` and `whisper` CLI tools. Use these when a gogol needs to transcribe a video URL to text.

| Function | Purpose |
| --- | --- |
| `fetchVideoMetadata(url)` | Runs `yt-dlp --dump-single-json` to get title, uploader, upload date. |
| `fetchVideoCaptions(url, tempDir)` | Downloads subtitles via `yt-dlp --write-subs --write-auto-subs`, parses VTT/SRT to plain text. Returns `null` if no captions available. |
| `downloadVideoAudio(url, tempDir)` | Downloads and extracts audio as MP3 via `yt-dlp -x --audio-format mp3`. Returns path to the MP3 file. |
| `isWhisperAvailable()` | Probes whether the `whisper` CLI is installed. |
| `transcribeWithWhisper(audioPath, outputDir, model, language?)` | Runs `whisper` CLI to transcribe an audio file to text. |
| `formatTranscriptWithMetadata(metadata, text, source)` | Formats a transcript with a metadata header (URL, title, uploader, source). |

External CLI dependencies: `yt-dlp` (required for all functions), `whisper` (required only for transcription fallback). These are not npm packages — they must be installed on the host system.

---

## Peer dependencies

- `better-sqlite3` — `CrossDbReadOnlyStep`, `SummarizeAuditStep` (type-only imports)
- `playwright` — `PlaywrightPooledStep`
- `@syrokomskyi/rate-limit` — `RateLimitedHttpStep` and `PlaywrightPooledStep` concurrency primitives (workspace dep, already in package.json)

The root `pnpm-workspace.yaml` lists `better-sqlite3` in `onlyBuiltDependencies` so native builds happen once at install time.
