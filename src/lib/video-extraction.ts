/*
<MODULE_CONTRACT>
  <purpose>Provides reusable primitives for extracting text from video sources: yt-dlp caption/subtitle fetching, video metadata retrieval, audio download, and local Whisper transcription fallback.</purpose>
  <non-goals>
    <item>Does not orchestrate pipeline steps or manage pipeline state.</item>
    <item>Does not handle AI model interactions or prompt construction.</item>
    <item>Does not implement video encoding or format conversion beyond yt-dlp and Whisper CLI usage.</item>
  </non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial creation of shared video extraction primitives: yt-dlp captions, metadata, audio download, and Whisper CLI transcription.</item>
  <item>Removed global regex g flag from VTT_TIMESTAMP_PATTERN to prevent stateful lastIndex false negatives in loop .test() calls.</item>
</CHANGE_SUMMARY>
*/

import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

export type VideoMetadata = {
  title?: string;
  uploader?: string;
  uploadDate?: string;
  url: string;
};

export type CaptionResult = {
  text: string;
  source: "captions" | "whisper";
  language?: string;
};

const runCommand = async (options: {
  cwd: string;
  command: string;
  args: string[];
}): Promise<{ stdout: string; stderr: string }> => {
  const { cwd, command, args } = options;

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const errorMessage =
        stderr.trim() || stdout.trim() || `${command} exited with code ${code ?? "unknown"}`;
      reject(new Error(errorMessage));
    });
  });
};

const isNonEmptyString = (value: unknown): value is string => {
  return typeof value === "string" && value.trim().length > 0;
};

const listFilesRecursive = async (dirPath: string): Promise<string[]> => {
  const dirEntries = await readdir(dirPath, { withFileTypes: true });
  const nested = await Promise.all(
    dirEntries.map(async (entry) => {
      const absolutePath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        return await listFilesRecursive(absolutePath);
      }
      if (entry.isFile()) {
        return [absolutePath];
      }
      return [];
    }),
  );
  return nested.flat();
};

const VTT_HEADER_PATTERN = /^WEBVTT.*$/m;
const VTT_TIMESTAMP_PATTERN =
  /(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})/;

const parseVttContent = (content: string): string => {
  const lines = content.replace(VTT_HEADER_PATTERN, "").split("\n");
  const textLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (VTT_TIMESTAMP_PATTERN.test(trimmed)) continue;
    if (trimmed.startsWith("NOTE")) continue;
    if (trimmed.startsWith("STYLE")) continue;
    if (trimmed.startsWith("REGION")) continue;
    textLines.push(trimmed.replace(/<[^>]+>/g, ""));
  }
  return textLines.join(" ").replace(/\s+/g, " ").trim();
};

const parseSrtContent = (content: string): string => {
  const lines = content.split("\n");
  const textLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\d+$/.test(trimmed)) continue;
    if (VTT_TIMESTAMP_PATTERN.test(trimmed) || trimmed.includes("-->")) continue;
    textLines.push(trimmed.replace(/<[^>]+>/g, ""));
  }
  return textLines.join(" ").replace(/\s+/g, " ").trim();
};

const parseSubtitleFile = (filePath: string, content: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".vtt" || ext === ".srv3" || ext === ".srv2" || ext === ".srv1") {
    return parseVttContent(content);
  }
  if (ext === ".srt") {
    return parseSrtContent(content);
  }
  return parseVttContent(content);
};

export const fetchVideoMetadata = async (url: string): Promise<VideoMetadata> => {
  const { stdout } = await runCommand({
    cwd: process.cwd(),
    command: "yt-dlp",
    args: ["--dump-single-json", "--skip-download", url],
  });

  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  return {
    title: isNonEmptyString(parsed.title) ? parsed.title : undefined,
    uploader: isNonEmptyString(parsed.uploader) ? parsed.uploader : undefined,
    uploadDate: isNonEmptyString(parsed.upload_date) ? parsed.upload_date : undefined,
    url,
  };
};

export const fetchVideoCaptions = async (url: string, tempDir: string): Promise<string | null> => {
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });

  try {
    await runCommand({
      cwd: tempDir,
      command: "yt-dlp",
      args: [
        "--write-subs",
        "--write-auto-subs",
        "--skip-download",
        "--sub-format",
        "vtt/srt/best",
        "--sub-lang",
        "en,ru,uk,de",
        "-o",
        "%(id)s.%(ext)s",
        url,
      ],
    });
  } catch {
    return null;
  }

  const files = await listFilesRecursive(tempDir);
  const subtitleFiles = files.filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return [".vtt", ".srt", ".srv1", ".srv2", ".srv3"].includes(ext);
  });

  if (subtitleFiles.length === 0) {
    return null;
  }

  const sorted = subtitleFiles.sort((a, b) => {
    const aIsAuto = a.includes(".auto.");
    const bIsAuto = b.includes(".auto.");
    if (aIsAuto !== bIsAuto) return aIsAuto ? 1 : -1;
    return a.localeCompare(b);
  });

  for (const filePath of sorted) {
    const content = await readFile(filePath, "utf8");
    const text = parseSubtitleFile(filePath, content);
    if (text.length > 0) {
      return text;
    }
  }

  return null;
};

export const downloadVideoAudio = async (url: string, tempDir: string): Promise<string> => {
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });

  await runCommand({
    cwd: tempDir,
    command: "yt-dlp",
    args: ["-x", "--audio-format", "mp3", "-o", "%(id)s.%(ext)s", url],
  });

  const files = await listFilesRecursive(tempDir);
  const audioFiles = files.filter((f) => path.extname(f).toLowerCase() === ".mp3");

  if (audioFiles.length === 0) {
    throw new Error("yt-dlp did not produce an mp3 file");
  }

  return audioFiles[0];
};

export const isWhisperAvailable = async (): Promise<boolean> => {
  try {
    await runCommand({
      cwd: process.cwd(),
      command: "whisper",
      args: ["--help"],
    });
    return true;
  } catch {
    return false;
  }
};

export const transcribeWithWhisper = async (
  audioPath: string,
  outputDir: string,
  model: string,
  language?: string,
): Promise<string> => {
  await mkdir(outputDir, { recursive: true });

  const args = [audioPath, "--model", model, "--output_format", "txt", "--output_dir", outputDir];

  if (language) {
    args.push("--language", language);
  }

  await runCommand({
    cwd: process.cwd(),
    command: "whisper",
    args,
  });

  const files = await readdir(outputDir);
  const txtFile = files.find((f) => f.endsWith(".txt"));
  if (!txtFile) {
    throw new Error("Whisper did not produce a .txt output file");
  }

  const text = await readFile(path.join(outputDir, txtFile), "utf8");
  return text.trim();
};

export const formatTranscriptWithMetadata = (
  metadata: VideoMetadata,
  text: string,
  source: "captions" | "whisper",
): string => {
  const headerLines: string[] = [`# Video transcript`, "", `**Source URL:** ${metadata.url}`];

  if (metadata.title) headerLines.push(`**Title:** ${metadata.title}`);
  if (metadata.uploader) headerLines.push(`**Uploader:** ${metadata.uploader}`);
  if (metadata.uploadDate) headerLines.push(`**Upload date:** ${metadata.uploadDate}`);

  headerLines.push(`**Transcript source:** ${source}`);
  headerLines.push("");
  headerLines.push("---");
  headerLines.push("");

  return headerLines.join("\n") + text;
};
