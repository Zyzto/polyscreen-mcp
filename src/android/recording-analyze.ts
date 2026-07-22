import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

export interface AnalyzeMark {
  label: string;
  offsetMs: number;
  wallClockIso?: string | undefined;
}

export type AnalyzeMode = "default" | "flash";

export interface AnalyzeOptions {
  /** Preset: `flash` enables sample-frame export and flash-oriented thresholds. */
  mode?: AnalyzeMode | undefined;
  fps?: number | undefined;
  blackThreshold?: number | undefined;
  dimThreshold?: number | undefined;
  exportSampleFrames?: boolean | undefined;
  /** When false (default), omit full per-frame timeline from the result. */
  includeFullTimeline?: boolean | undefined;
  /** Downsample step for timelineSummary (default 200ms). */
  timelineDownsampleMs?: number | undefined;
  marks?: AnalyzeMark[] | undefined;
  artifactRoot?: string | undefined;
}

export interface ResolvedAnalyzeOptions {
  mode?: AnalyzeMode | undefined;
  fps: number;
  blackThreshold: number;
  dimThreshold: number;
  exportSampleFrames: boolean;
  includeFullTimeline: boolean;
  timelineDownsampleMs: number;
  marks?: AnalyzeMark[] | undefined;
  artifactRoot?: string | undefined;
}

export function resolveAnalyzeOptions(
  options: AnalyzeOptions = {},
): ResolvedAnalyzeOptions {
  const flash = options.mode === "flash";
  return {
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
    fps: options.fps ?? 30,
    blackThreshold: options.blackThreshold ?? 16,
    dimThreshold: options.dimThreshold ?? 80,
    exportSampleFrames: options.exportSampleFrames ?? flash,
    includeFullTimeline: options.includeFullTimeline ?? false,
    timelineDownsampleMs: options.timelineDownsampleMs ?? (flash ? 100 : 200),
    ...(options.marks !== undefined ? { marks: options.marks } : {}),
    ...(options.artifactRoot !== undefined
      ? { artifactRoot: options.artifactRoot }
      : {}),
  };
}

export type FrameBucket =
  | "true_black"
  | "near_black_content"
  | "system_launcher_idle"
  | "dark_app_ui"
  | "light_app_ui"
  | "other";

export interface MeanGrayPoint {
  tMs: number;
  mean: number;
  bucket: FrameBucket;
}

export interface AnalyzeSample {
  label: string;
  path: string;
  offsetMs: number;
  mean: number;
}

export interface FrameRun {
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface RecordingAnalysis {
  path: string;
  durationMs: number;
  width: number;
  height: number;
  frameCount: number;
  sampleFps: number;
  blackThreshold: number;
  dimThreshold: number;
  blackFrameCount: number;
  dimFrameCount: number;
  /** Convenience for agents: blackFrameCount > 0 at configured threshold. */
  hasBlackFlash: boolean;
  hasDimFlash: boolean;
  maxBlackRunMs: number;
  maxDimRunMs: number;
  firstBlackOffsetMs: number | null;
  lastBlackOffsetMs: number | null;
  firstDimOffsetMs: number | null;
  lastDimOffsetMs: number | null;
  /** Contiguous black/dim runs (compact; capped). */
  blackRuns: FrameRun[];
  dimRuns: FrameRun[];
  blackRunsTruncated: boolean;
  dimRunsTruncated: boolean;
  /** Compact downsampled timeline (always present). */
  timelineSummary: MeanGrayPoint[];
  /** Full per-frame timeline only when includeFullTimeline is true. */
  meanGrayTimeline?: MeanGrayPoint[];
  marks: AnalyzeMark[];
  samples: AnalyzeSample[];
  bucketCounts: Record<FrameBucket, number>;
}

interface ProbeInfo {
  durationMs: number;
  width: number;
  height: number;
}

export async function analyzeRecording(
  path: string,
  options: AnalyzeOptions = {},
): Promise<RecordingAnalysis> {
  const resolved = resolveAnalyzeOptions(options);
  const fps = clamp(resolved.fps, 1, 60);
  // Default aligns with true_black (mean <= 15): count frames with mean < 16.
  const blackThreshold = clamp(resolved.blackThreshold, 0, 255);
  const dimThreshold = clamp(resolved.dimThreshold, 0, 255);
  const includeFullTimeline = resolved.includeFullTimeline;
  const timelineDownsampleMs = clamp(resolved.timelineDownsampleMs, 50, 5_000);
  if (dimThreshold < blackThreshold) {
    throw new Error("dimThreshold must be >= blackThreshold");
  }

  const probe = await ffprobe(path);
  const marks =
    resolved.marks ?? (await loadSidecarMarks(path)).slice().sort(byOffset);
  const timeline = await sampleMeanGray(path, probe, fps);
  const samples: AnalyzeSample[] = [];

  const frameStepMs = Math.round(1000 / fps);
  const bucketCounts: Record<FrameBucket, number> = {
    true_black: 0,
    near_black_content: 0,
    system_launcher_idle: 0,
    dark_app_ui: 0,
    light_app_ui: 0,
    other: 0,
  };
  for (const point of timeline) bucketCounts[point.bucket] += 1;

  const blackStats = collectThresholdRuns(
    timeline,
    blackThreshold,
    frameStepMs,
  );
  const dimStats = collectThresholdRuns(timeline, dimThreshold, frameStepMs);
  const blackFrameCount = blackStats.frameCount;
  const dimFrameCount = dimStats.frameCount;
  const firstBlackOffsetMs = blackStats.firstOffsetMs;
  const lastBlackOffsetMs = blackStats.lastOffsetMs;
  const firstDimOffsetMs = dimStats.firstOffsetMs;
  const lastDimOffsetMs = dimStats.lastOffsetMs;
  const maxBlackRunMs = blackStats.maxRunMs;
  const maxDimRunMs = dimStats.maxRunMs;
  const blackRuns = blackStats.runs;
  const dimRuns = dimStats.runs;
  const blackRunsTruncated = blackStats.runsTruncated;
  const dimRunsTruncated = dimStats.runsTruncated;

  if (resolved.exportSampleFrames) {
    const outDir = join(
      resolved.artifactRoot ?? dirname(path),
      `${basename(path, ".mp4")}-samples`,
    );
    await mkdir(outDir, { recursive: true });
    const jobs: Array<{ label: string; offsetMs: number }> = [];
    if (firstBlackOffsetMs !== null) {
      jobs.push({ label: "first_black", offsetMs: firstBlackOffsetMs });
    }
    if (
      lastBlackOffsetMs !== null &&
      lastBlackOffsetMs !== firstBlackOffsetMs
    ) {
      jobs.push({ label: "last_black", offsetMs: lastBlackOffsetMs });
    }
    for (const [index, mark] of marks.entries()) {
      jobs.push({
        label: `mark_${index}_${sanitize(mark.label)}`,
        offsetMs: mark.offsetMs,
      });
    }
    // Parallel ffmpeg exports (bounded concurrency); unique labels avoid races.
    const exported = new Array<AnalyzeSample>(jobs.length);
    const concurrency = Math.min(4, Math.max(1, jobs.length));
    let next = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < jobs.length) {
          const index = next;
          next += 1;
          const job = jobs[index]!;
          exported[index] = await exportFrame(
            path,
            outDir,
            job.label,
            job.offsetMs,
            timeline,
          );
        }
      }),
    );
    samples.push(...exported);
  }

  return {
    path,
    durationMs: probe.durationMs,
    width: probe.width,
    height: probe.height,
    frameCount: timeline.length,
    sampleFps: fps,
    blackThreshold,
    dimThreshold,
    blackFrameCount,
    dimFrameCount,
    hasBlackFlash: blackFrameCount > 0,
    hasDimFlash: dimFrameCount > 0,
    maxBlackRunMs,
    maxDimRunMs,
    firstBlackOffsetMs,
    lastBlackOffsetMs,
    firstDimOffsetMs,
    lastDimOffsetMs,
    blackRuns,
    dimRuns,
    blackRunsTruncated,
    dimRunsTruncated,
    timelineSummary: downsampleTimeline(timeline, timelineDownsampleMs),
    ...(includeFullTimeline ? { meanGrayTimeline: timeline } : {}),
    marks,
    samples,
    bucketCounts,
  };
}

const MAX_REPORTED_RUNS = 40;

export function collectThresholdRuns(
  timeline: MeanGrayPoint[],
  threshold: number,
  frameStepMs: number,
): {
  frameCount: number;
  firstOffsetMs: number | null;
  lastOffsetMs: number | null;
  maxRunMs: number;
  runs: FrameRun[];
  runsTruncated: boolean;
} {
  let frameCount = 0;
  let firstOffsetMs: number | null = null;
  let lastOffsetMs: number | null = null;
  let maxRunMs = 0;
  let runStart: number | null = null;
  let runCount = 0;
  const runs: FrameRun[] = [];

  const closeRun = (endMs: number) => {
    if (runStart === null) return;
    const durationMs = Math.max(frameStepMs, endMs - runStart + frameStepMs);
    maxRunMs = Math.max(maxRunMs, durationMs);
    runCount += 1;
    if (runs.length < MAX_REPORTED_RUNS) {
      runs.push({ startMs: runStart, endMs, durationMs });
    }
    runStart = null;
  };

  for (const point of timeline) {
    if (point.mean < threshold) {
      frameCount += 1;
      firstOffsetMs ??= point.tMs;
      lastOffsetMs = point.tMs;
      runStart ??= point.tMs;
    } else {
      closeRun(lastOffsetMs ?? point.tMs);
    }
  }
  if (runStart !== null && lastOffsetMs !== null) {
    closeRun(lastOffsetMs);
  }

  return {
    frameCount,
    firstOffsetMs,
    lastOffsetMs,
    maxRunMs,
    runs,
    runsTruncated: runCount > MAX_REPORTED_RUNS,
  };
}

export function classifyMeanGray(mean: number): FrameBucket {
  if (mean <= 15) return "true_black";
  if (mean <= 29) return "near_black_content";
  if (mean >= 30 && mean <= 55) return "system_launcher_idle";
  if (mean >= 190 && mean <= 230) return "light_app_ui";
  if (mean > 55 && mean < 120) return "dark_app_ui";
  return "other";
}

export function downsampleTimeline(
  timeline: MeanGrayPoint[],
  stepMs: number,
): MeanGrayPoint[] {
  if (timeline.length === 0) return [];
  const summary: MeanGrayPoint[] = [];
  let nextAt = 0;
  for (const point of timeline) {
    if (summary.length === 0 || point.tMs >= nextAt) {
      summary.push(point);
      nextAt = point.tMs + stepMs;
    }
  }
  const last = timeline.at(-1)!;
  if (summary.at(-1)?.tMs !== last.tMs) summary.push(last);
  return summary;
}

export async function resolveRecordingPath(
  input: { path?: string | undefined; artifactUri?: string | undefined },
  artifactRoot: string,
): Promise<string> {
  if (!input.path && !input.artifactUri) {
    throw new Error("Provide path or artifactUri");
  }
  const root = await realpath(artifactRoot).catch(() => resolve(artifactRoot));
  let candidate: string;
  if (input.path) {
    candidate = resolve(input.path);
  } else {
    const match = input.artifactUri!.match(/^mobile:\/\/artifacts\/(.+)$/);
    if (!match?.[1]) {
      throw new Error(`Unsupported artifactUri: ${input.artifactUri}`);
    }
    const name = decodeURIComponent(match[1]);
    if (
      name !== basename(name) ||
      name.includes("\0") ||
      name === "." ||
      name === ".."
    ) {
      throw new Error(`Invalid artifactUri name: ${input.artifactUri}`);
    }
    candidate = resolve(artifactRoot, name);
  }

  // Prefer realpath so symlink escapes cannot leave the artifact root.
  const checked = await realpath(candidate).catch(() => candidate);
  if (checked !== root && !checked.startsWith(root + sep)) {
    throw new Error(`Recording path escapes artifact root: ${candidate}`);
  }
  return checked;
}

async function loadSidecarMarks(path: string): Promise<AnalyzeMark[]> {
  const sidecar = path.replace(/\.mp4$/i, ".marks.json");
  try {
    const raw: unknown = JSON.parse(await readFile(sidecar, "utf8"));
    if (
      typeof raw !== "object" ||
      raw === null ||
      !("marks" in raw) ||
      !Array.isArray((raw as { marks: unknown }).marks)
    ) {
      return [];
    }
    return (raw as { marks: AnalyzeMark[] }).marks.filter(
      (mark) =>
        typeof mark?.label === "string" &&
        typeof mark?.offsetMs === "number" &&
        Number.isFinite(mark.offsetMs),
    );
  } catch {
    return [];
  }
}

async function ffprobe(path: string): Promise<ProbeInfo> {
  const stdout = await runCaptured("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height:format=duration",
    "-of",
    "json",
    path,
  ]);
  const parsed: unknown = JSON.parse(stdout);
  const root = parsed as {
    streams?: Array<{ width?: number; height?: number }>;
    format?: { duration?: string };
  };
  const width = Number(root.streams?.[0]?.width ?? 0);
  const height = Number(root.streams?.[0]?.height ?? 0);
  const durationSec = Number(root.format?.duration ?? 0);
  if (!(width > 0 && height > 0) || !(durationSec >= 0)) {
    throw new Error(`ffprobe could not read video metadata from ${path}`);
  }
  return {
    width,
    height,
    durationMs: Math.round(durationSec * 1000),
  };
}

async function sampleMeanGray(
  path: string,
  probe: ProbeInfo,
  fps: number,
): Promise<MeanGrayPoint[]> {
  const scaledWidth = 160;
  const scaledHeight = Math.max(
    2,
    Math.round((scaledWidth * probe.height) / probe.width) & ~1,
  );
  const frameBytes = scaledWidth * scaledHeight;
  const args = [
    "-v",
    "error",
    "-i",
    path,
    "-vf",
    // Downscale before gray mean — black/launcher buckets stay valid at low res.
    `fps=${fps},scale=${scaledWidth}:${scaledHeight},format=gray`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    "pipe:1",
  ];

  return await new Promise<MeanGrayPoint[]>((resolve, reject) => {
    const child = spawn("ffmpeg", args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const timeline: MeanGrayPoint[] = [];
    let pending = Buffer.alloc(0);
    let frameIndex = 0;
    const errChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= frameBytes) {
        const frame = pending.subarray(0, frameBytes);
        pending = pending.subarray(frameBytes);
        let sum = 0;
        for (let p = 0; p < frame.length; p += 1) sum += frame[p]!;
        const mean = sum / frame.length;
        timeline.push({
          tMs: Math.round((frameIndex * 1000) / fps),
          mean: Math.round(mean * 10) / 10,
          bucket: classifyMeanGray(mean),
        });
        frameIndex += 1;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `ffmpeg failed (${code}): ${Buffer.concat(errChunks).toString("utf8").trim()}`,
          ),
        );
        return;
      }
      resolve(timeline);
    });
  });
}

async function exportFrame(
  path: string,
  outDir: string,
  label: string,
  offsetMs: number,
  timeline: MeanGrayPoint[],
): Promise<AnalyzeSample> {
  const filePath = join(outDir, `${label}-${offsetMs}ms.png`);
  const seconds = Math.max(0, offsetMs) / 1000;
  await runCaptured("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-ss",
    seconds.toFixed(3),
    "-i",
    path,
    "-frames:v",
    "1",
    filePath,
  ]);
  const nearest =
    timeline.find((point) => point.tMs >= offsetMs) ?? timeline.at(-1);
  await writeFile(
    filePath.replace(/\.png$/i, ".json"),
    JSON.stringify({
      label,
      offsetMs,
      mean: nearest?.mean ?? null,
      path: filePath,
    }),
    "utf8",
  );
  return {
    label,
    path: filePath,
    offsetMs,
    mean: nearest?.mean ?? 0,
  };
}

function runCaptured(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let bytes = 0;
    const maxBytes = 16 * 1024 * 1024;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        child.kill("SIGKILL");
        reject(new Error(`${command} output exceeded ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `${command} failed (${code}): ${Buffer.concat(errChunks).toString("utf8").trim()}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sanitize(label: string): string {
  return label.replaceAll(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64);
}

function byOffset(a: AnalyzeMark, b: AnalyzeMark): number {
  return a.offsetMs - b.offsetMs;
}
