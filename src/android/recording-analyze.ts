import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface AnalyzeMark {
  label: string;
  offsetMs: number;
}

export interface AnalyzeOptions {
  fps?: number | undefined;
  blackThreshold?: number | undefined;
  dimThreshold?: number | undefined;
  exportSampleFrames?: boolean | undefined;
  marks?: AnalyzeMark[] | undefined;
  artifactRoot?: string | undefined;
}

export type FrameBucket =
  | "true_black"
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
  maxBlackRunMs: number;
  maxDimRunMs: number;
  firstBlackOffsetMs: number | null;
  lastBlackOffsetMs: number | null;
  firstDimOffsetMs: number | null;
  lastDimOffsetMs: number | null;
  meanGrayTimeline: MeanGrayPoint[];
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
  const fps = clamp(options.fps ?? 30, 1, 60);
  const blackThreshold = clamp(options.blackThreshold ?? 40, 0, 255);
  const dimThreshold = clamp(options.dimThreshold ?? 80, 0, 255);
  if (dimThreshold < blackThreshold) {
    throw new Error("dimThreshold must be >= blackThreshold");
  }

  const probe = await ffprobe(path);
  const marks =
    options.marks ?? (await loadSidecarMarks(path)).slice().sort(byOffset);
  const timeline = await sampleMeanGray(path, probe, fps);
  const samples: AnalyzeSample[] = [];

  let blackFrameCount = 0;
  let dimFrameCount = 0;
  let firstBlackOffsetMs: number | null = null;
  let lastBlackOffsetMs: number | null = null;
  let firstDimOffsetMs: number | null = null;
  let lastDimOffsetMs: number | null = null;
  let maxBlackRunMs = 0;
  let maxDimRunMs = 0;
  let blackRunStart: number | null = null;
  let dimRunStart: number | null = null;
  const bucketCounts: Record<FrameBucket, number> = {
    true_black: 0,
    system_launcher_idle: 0,
    dark_app_ui: 0,
    light_app_ui: 0,
    other: 0,
  };

  for (const point of timeline) {
    bucketCounts[point.bucket] += 1;
    const isBlack = point.mean < blackThreshold;
    const isDim = point.mean < dimThreshold;

    if (isBlack) {
      blackFrameCount += 1;
      firstBlackOffsetMs ??= point.tMs;
      lastBlackOffsetMs = point.tMs;
      blackRunStart ??= point.tMs;
    } else if (blackRunStart !== null) {
      maxBlackRunMs = Math.max(maxBlackRunMs, point.tMs - blackRunStart);
      blackRunStart = null;
    }

    if (isDim) {
      dimFrameCount += 1;
      firstDimOffsetMs ??= point.tMs;
      lastDimOffsetMs = point.tMs;
      dimRunStart ??= point.tMs;
    } else if (dimRunStart !== null) {
      maxDimRunMs = Math.max(maxDimRunMs, point.tMs - dimRunStart);
      dimRunStart = null;
    }
  }
  if (blackRunStart !== null && timeline.length > 0) {
    const last = timeline.at(-1)!;
    maxBlackRunMs = Math.max(
      maxBlackRunMs,
      last.tMs - blackRunStart + Math.round(1000 / fps),
    );
  }
  if (dimRunStart !== null && timeline.length > 0) {
    const last = timeline.at(-1)!;
    maxDimRunMs = Math.max(
      maxDimRunMs,
      last.tMs - dimRunStart + Math.round(1000 / fps),
    );
  }

  if (options.exportSampleFrames) {
    const outDir = join(
      options.artifactRoot ?? dirname(path),
      `${basename(path, ".mp4")}-samples`,
    );
    await mkdir(outDir, { recursive: true });

    if (firstBlackOffsetMs !== null) {
      samples.push(
        await exportFrame(
          path,
          outDir,
          "first_black",
          firstBlackOffsetMs,
          timeline,
        ),
      );
    }
    if (
      lastBlackOffsetMs !== null &&
      lastBlackOffsetMs !== firstBlackOffsetMs
    ) {
      samples.push(
        await exportFrame(
          path,
          outDir,
          "last_black",
          lastBlackOffsetMs,
          timeline,
        ),
      );
    }
    for (const mark of marks) {
      samples.push(
        await exportFrame(
          path,
          outDir,
          `mark_${sanitize(mark.label)}`,
          mark.offsetMs,
          timeline,
        ),
      );
    }
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
    maxBlackRunMs,
    maxDimRunMs,
    firstBlackOffsetMs,
    lastBlackOffsetMs,
    firstDimOffsetMs,
    lastDimOffsetMs,
    meanGrayTimeline: timeline,
    marks,
    samples,
    bucketCounts,
  };
}

export function classifyMeanGray(mean: number): FrameBucket {
  if (mean <= 15) return "true_black";
  if (mean >= 30 && mean <= 55) return "system_launcher_idle";
  if (mean >= 190 && mean <= 230) return "light_app_ui";
  if (mean > 55 && mean < 120) return "dark_app_ui";
  return "other";
}

export async function resolveRecordingPath(
  input: { path?: string | undefined; artifactUri?: string | undefined },
  artifactRoot: string,
): Promise<string> {
  if (input.path) return input.path;
  if (!input.artifactUri) {
    throw new Error("Provide path or artifactUri");
  }
  const match = input.artifactUri.match(/^mobile:\/\/artifacts\/(.+)$/);
  if (!match?.[1]) {
    throw new Error(`Unsupported artifactUri: ${input.artifactUri}`);
  }
  return join(artifactRoot, decodeURIComponent(match[1]));
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
  const frameBytes = probe.width * probe.height;
  const args = [
    "-v",
    "error",
    "-i",
    path,
    "-vf",
    `fps=${fps},format=gray`,
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
    JSON.stringify(
      { label, offsetMs, mean: nearest?.mean ?? null, path: filePath },
      null,
      2,
    ),
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
