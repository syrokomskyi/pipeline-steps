# @warpgogol/pipeline-steps

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE) [![npm](https://img.shields.io/npm/v/@warpgogol/pipeline-steps?logo=npm&logoColor=white)](https://www.npmjs.com/package/@warpgogol/pipeline-steps)

Reusable abstract step base classes for the pipeline framework — rate-limited HTTP, browser pooling, cross-DB reads, k-anonymity gates, human gates, video extraction, and environment profiling.

> Engineered at [Warpgogol](https://warpgogol.com) · Released as open source.

---

## Features

- **Rate-limited HTTP** — `RateLimitedHttpStep` with injectable `RateLimiterLike` (use `p-limit`, `bottleneck`, or any limiter)
- **Browser pooling** — `PlaywrightPooledStep` with `p-limit` concurrency control
- **Cross-DB reads** — `CrossDbReadOnlyStep` with WAL mode, streaming SHA-256, auto-close
- **K-anonymity gates** — `KAnonymityGateStep` for DSGVO-compliant publication
- **Human gates** — `PausePipelineStep` and `WaitHumanStep` for manual approval
- **Environment profiling** — `CaptureEnvironmentProfileStep` for audit reproducibility
- **LLM cost reports** — `LlmCostReportStep` for token usage tracking
- **Video extraction** — `yt-dlp` captions + Whisper transcription fallback

## Install

```bash
npm install @warpgogol/pipeline-core @warpgogol/pipeline-steps

# Optional peer deps (only install what you use)
npm install playwright better-sqlite3
```

### Peer dependencies

All peer dependencies are optional — install only what you use:

| Package           | Required for              | Optional |
| ----------------- | ------------------------- | -------- |
| `playwright`      | `PlaywrightPooledStep`    | Yes      |
| `better-sqlite3`  | `CrossDbReadOnlyStep`     | Yes      |
| `axe-core`        | Axe audit features        | Yes      |
| `lighthouse`      | Lighthouse audit features | Yes      |
| `chrome-launcher` | Chrome launch helpers     | Yes      |

## Quick start

```ts
import { RateLimitedHttpStep } from "@warpgogol/pipeline-steps";
import pLimit from "p-limit";
import type { PipelineStepContext } from "@warpgogol/pipeline-core";

class FetchApiStep extends RateLimitedHttpStep<PipelineStepContext> {
  readonly id = "fetch-api";
  readonly executionSemantics = "pure_artifact" as const;

  protected createLimiter() {
    const limit = pLimit(4);
    return {
      schedule: <T>(fn: () => Promise<T>) => limit(fn),
      inFlight: () => limit.activeCount,
      queueDepth: () => limit.pendingCount,
    };
  }

  async run(ctx) {
    for (const url of ctx.state.urls) {
      await this.schedule(() => fetch(url));
    }
  }
}
```

## Dispatch table — which base class do I need?

| Your gogol… | Use | Why |
| --- | --- | --- |
| …calls a 3rd-party HTTP API with rate limits | **`RateLimitedHttpStep`** | Injectable `RateLimiterLike` via `createLimiter()` |
| …drives a headless browser (Playwright) | **`PlaywrightPooledStep`** | Concurrency-gated `withBrowser` / `withPage` via `p-limit` |
| …reads an upstream pipeline's SQLite DB read-only | **`CrossDbReadOnlyStep`** | `{ readonly: true }` + WAL + FK pragmas + streaming SHA-256 + auto-close |
| …publishes data derived from human subjects (DSGVO) | **`KAnonymityGateStep`** | `enforceKAnonymity(ctx)` — warn or enforce with per-stratum report.json |
| …needs a synchronous manual signoff | **`WaitHumanStep`** | Requires a decision artifact bound to the current reviewed fingerprint |
| …stops the pipeline unconditionally | **`PausePipelineStep`** | Thin wrapper; no side effects beyond the pause marker |
| …captures OS / Node / hardware / tool versions | **`CaptureEnvironmentProfileStep`** | System info via `systeminformation`, JSON + Markdown artifacts |
| …tracks LLM token usage and costs | **`LlmCostReportStep`** | Aggregates token counts and estimated costs per run |

## Exports

| Export                                    | Description                                |
| ----------------------------------------- | ------------------------------------------ |
| `RateLimitedHttpStep<TContext>`           | HTTP step with injectable rate limiter     |
| `RateLimiterLike`                         | Interface for rate limiter implementations |
| `PlaywrightPooledStep<TContext>`          | Browser pooling with `p-limit` concurrency |
| `CrossDbReadOnlyStep<TContext>`           | Read-only SQLite access with WAL + SHA-256 |
| `KAnonymityGateStep<TContext>`            | K-anonymity gate for DSGVO compliance      |
| `PausePipelineStep<TContext>`             | Unconditional pause step                   |
| `WaitHumanStep<TContext>`                 | Human approval gate step                   |
| `CaptureEnvironmentProfileStep<TContext>` | Environment profile capture                |
| `LlmCostReportStep<TContext>`             | LLM cost aggregation step                  |
| `CompletionStepContracts`                 | Completion contract types                  |
| `fetchVideoMetadata(url)`                 | Get video metadata via `yt-dlp`            |
| `fetchVideoCaptions(url, dir)`            | Download and parse video captions          |
| `downloadVideoAudio(url, dir)`            | Download audio as MP3 via `yt-dlp`         |
| `transcribeWithWhisper(path, dir)`        | Transcribe audio via Whisper CLI           |
| `isWhisperAvailable()`                    | Probe for Whisper CLI                      |
| `DEFAULT_K_MIN`                           | Default k-anonymity threshold (5)          |

## `RateLimitedHttpStep` — usage

Override `createLimiter()` to provide your own rate limiter implementation. The base class wraps every call to `this.schedule(fn)` with the limiter.

```ts
import pLimit from "p-limit";

class FetchStep extends RateLimitedHttpStep<Ctx> {
  protected createLimiter() {
    const limit = pLimit(4);
    return {
      schedule: <T>(fn: () => Promise<T>) => limit(fn),
      inFlight: () => limit.activeCount,
      queueDepth: () => limit.pendingCount,
    };
  }

  async run(ctx: Ctx) {
    for (const site of ctx.state.sites) {
      await this.schedule(() => fetch(site.url));
    }
  }
}
```

Inspect at runtime: `this.inFlight()`, `this.queueDepth()`.

## `PlaywrightPooledStep` — usage

`playwright` is a **peer dependency** — loaded via dynamic import so this package stays install-light.

```ts
await this.withPage(async (page) => {
  await page.goto(url);
  return await page.title();
});
```

Global concurrency is governed by `p-limit`; override `getMaxConcurrentPages()` to change it.

## `CrossDbReadOnlyStep` — usage

```ts
const result = await this.withReadOnlyDbs(async () => {
  const db = this.openReadOnly("scoresDb", scoresPath);
  const rows = db.prepare("SELECT ...").all();
  return { rows };
});
// db is already closed; this.inputHashes has SHA-256 of each file
```

`openReadOnly` throws at runtime if called outside `withReadOnlyDbs` — prevents DB leaks.

## `KAnonymityGateStep` — usage

Override `collectStrata(ctx)` to return `Stratum` objects. `enforceKAnonymity(ctx)` returns `KAnonymityOutcome` with `passedStrataKeys` and `failedStrataKeys`.

- `warn` (default): logs failures, returns the outcome
- `enforce`: throws on any failing stratum

Default `K_MIN = 5` (exported as `DEFAULT_K_MIN`). Writes `report.json` for audit.

## Video extraction utilities

Reusable helper functions for extracting text from video sources via `yt-dlp` and `whisper` CLI tools. These are not npm packages — they must be installed on the host system.

| Function | Purpose |
| --- | --- |
| `fetchVideoMetadata(url)` | Get title, uploader, upload date via `yt-dlp` |
| `fetchVideoCaptions(url, tempDir)` | Download subtitles, parse VTT/SRT to text |
| `downloadVideoAudio(url, tempDir)` | Download audio as MP3 via `yt-dlp` |
| `isWhisperAvailable()` | Probe for `whisper` CLI |
| `transcribeWithWhisper(audioPath, outputDir, model, language?)` | Transcribe audio to text |
| `formatTranscriptWithMetadata(metadata, text, source)` | Format transcript with metadata header |

## Changelog

[CHANGELOG.md](CHANGELOG.md)

## License

Apache-2.0 — see [LICENSE](LICENSE)

## Open Engineering

This package originated from production engineering work at [Warpgogol](https://warpgogol.com), an engineering studio in Germany.

We publish reusable parts of our infrastructure when they can be useful beyond our own projects. It is published independently of any Warpgogol commercial service. Using this package does not create any dependency on Warpgogol.

Built for real systems. Shared openly.
