/*
<MODULE_CONTRACT>
<purpose>Manages read-only access to upstream SQLite databases, ensuring proper opening, hashing for provenance, and automatic closure.</purpose>
<non-goals>
  <item>Does not handle write operations to databases.</item>
  <item>Does not manage databases other than SQLite.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial implementation of CrossDbReadOnlyStep for managing read-only database operations.</item>
</CHANGE_SUMMARY>
*/

/**
 * CrossDbReadOnlyStep — abstract step that opens upstream SQLite DBs
 * read-only, hashes them for provenance, and auto-closes on teardown.
 *
 * Every gogol that reads from another pipeline's DB (hdri-scoring reads
 * audits, hdri-publication reads scores + audits + core, etc.) needs:
 *   1. Open with `{ readonly: true }` + `journal_mode = WAL` + `foreign_keys = ON`
 *   2. Compute SHA-256 of the file for the MANIFEST / pipeline_inputs record
 *   3. Close cleanly even on error
 *
 * This base class provides `this.openReadOnly(path)` + automatic teardown
 * and a `this.inputHashes` map collected during the run.
 *
 * Extracted from Phase 7 (hdri-publication LoadPublicationDataGogol) and
 * Phase 6 (site-deep-audit IngestSelfReportsGogol) duplicates.
 *
 * Usage (prefer the return-value form — it avoids TS narrowing issues
 * with shared `let` variables captured inside the async callback):
 *
 *   const result = await this.withReadOnlyDbs(async () => {
 *     const scoresDb = this.openReadOnly('scoresDb', ctx.state.scoresDbPath);
 *     const auditsDb = this.openReadOnly('auditsDb', ctx.state.auditsDbPath);
 *     const rows = scoresDb.prepare('SELECT ...').all();
 *     return { rows };                                     // survives teardown
 *   });
 *   // After withReadOnlyDbs returns, all DBs are closed.
 *   // this.inputHashes contains SHA-256 per opened DB.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createRequire } from "node:module";
import { PipelineStep } from "@syrokomskyi/pipeline-core";
import type { PipelineStepContext } from "@syrokomskyi/pipeline-core";

// better-sqlite3 is a peer dependency: the app installs it, we import via
// createRequire so this package stays install-light.
const _require = createRequire(import.meta.url);

interface BetterSqliteDatabase {
  pragma: (sql: string) => unknown;
  close: () => void;
}

type BetterSqliteCtor = new (
  filename: string,
  options?: { readonly?: boolean },
) => BetterSqliteDatabase;

export abstract class CrossDbReadOnlyStep<
  TContext extends PipelineStepContext = PipelineStepContext,
> extends PipelineStep<TContext> {
  /** SHA-256 hex of each opened file, keyed by the caller's provided logical name. */
  protected readonly inputHashes: Map<string, string> = new Map();

  /** Absolute paths of each opened file, keyed by logical name (for MANIFEST). */
  protected readonly inputPaths: Map<string, string> = new Map();

  #openDbs: BetterSqliteDatabase[] = [];
  #insideWithReadOnlyDbs = false;

  /**
   * Opens a SQLite file read-only, sets WAL + FK pragmas, and tracks it
   * for automatic close. **Must only be called inside `withReadOnlyDbs`**;
   * otherwise the DB would leak (we refuse at runtime to fail loudly).
   *
   * @param logicalName stable key used in MANIFEST / logs (e.g. 'scoresDb')
   * @param absolutePath absolute file path
   */
  protected openReadOnly(logicalName: string, absolutePath: string): BetterSqliteDatabase {
    if (!this.#insideWithReadOnlyDbs) {
      throw new Error(
        `[${this.id}] openReadOnly("${logicalName}") called outside withReadOnlyDbs — ` +
          `wrap the read phase in this.withReadOnlyDbs(async () => { ... }) so the DB closes on teardown.`,
      );
    }
    const Database = _require("better-sqlite3") as BetterSqliteCtor;
    const db = new Database(absolutePath, { readonly: true });
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    this.#openDbs.push(db);
    this.inputPaths.set(logicalName, absolutePath);
    return db;
  }

  /**
   * Runs `fn` and, regardless of success or failure, closes every DB that
   * was opened via `openReadOnly`. Also computes streaming SHA-256 hashes
   * for every opened file (after the callback, so hashes reflect end-of-read
   * state).
   *
   * Returns whatever `fn` returns — prefer this form over capturing values
   * via outer `let` variables, because TypeScript cannot narrow a
   * closure-assigned `let` after an `await` boundary.
   *
   * State is cleared at entry, so re-running the same step instance is safe.
   */
  protected async withReadOnlyDbs<T>(fn: () => Promise<T>): Promise<T> {
    // Reset per-invocation state — a step instance may legitimately run twice.
    this.inputHashes.clear();
    this.inputPaths.clear();
    this.#openDbs = [];
    this.#insideWithReadOnlyDbs = true;

    try {
      const result = await fn();
      // Hash all opened files after the read phase.
      for (const [name, filePath] of this.inputPaths.entries()) {
        if (!this.inputHashes.has(name)) {
          this.inputHashes.set(name, await hashFileStreaming(filePath));
        }
      }
      return result;
    } finally {
      for (const db of this.#openDbs) {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
      this.#openDbs = [];
      this.#insideWithReadOnlyDbs = false;
    }
  }

  /** Convenience: dump the hashes as an object for MANIFEST records. */
  protected hashesAsObject(): Record<string, string> {
    return Object.fromEntries(this.inputHashes);
  }
}

/**
 * Streaming SHA-256 of a file — safe for multi-GB SQLite DBs because we never
 * buffer the whole file in memory (readFile would). Uses the default 64 KiB
 * createReadStream chunk size.
 */
function hashFileStreaming(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(filePath);
    s.on("data", (chunk) => h.update(chunk));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
}
