import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  analyzeRecording,
  classifyMeanGray,
  collectThresholdRuns,
  resolveAnalyzeOptions,
  resolveRecordingPath,
} from "../src/android/recording-analyze.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function makeClip(
  path: string,
  color: string,
  durationSec: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=${color}:s=64x64:d=${durationSec}`,
        "-pix_fmt",
        "yuv420p",
        path,
      ],
      { shell: false, stdio: ["ignore", "ignore", "pipe"] },
    );
    const err: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `ffmpeg fixture failed: ${Buffer.concat(err).toString("utf8")}`,
          ),
        );
    });
  });
}

describe("recording analysis", () => {
  it("classifies mean-gray brightness buckets", () => {
    expect(classifyMeanGray(5)).toBe("true_black");
    expect(classifyMeanGray(20)).toBe("near_black_content");
    expect(classifyMeanGray(40)).toBe("system_launcher_idle");
    expect(classifyMeanGray(90)).toBe("dark_app_ui");
    expect(classifyMeanGray(210)).toBe("light_app_ui");
    expect(classifyMeanGray(150)).toBe("other");
  });

  it("detects black frames and honors marks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polyscreen-analyze-"));
    cleanups.push(async () => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "black.mp4");
    await makeClip(path, "black", 0.4);
    await writeFile(
      join(dir, "black.marks.json"),
      JSON.stringify({
        marks: [{ label: "press-a", offsetMs: 100 }],
      }),
    );

    const analysis = await analyzeRecording(path, {
      fps: 10,
      exportSampleFrames: true,
      artifactRoot: dir,
    });

    expect(analysis.blackThreshold).toBe(16);
    expect(analysis.blackFrameCount).toBeGreaterThan(0);
    expect(analysis.hasBlackFlash).toBe(true);
    expect(analysis.firstBlackOffsetMs).toBe(0);
    expect(analysis.blackRuns.length).toBeGreaterThan(0);
    expect(analysis.marks).toEqual([{ label: "press-a", offsetMs: 100 }]);
    expect(analysis.bucketCounts.true_black).toBeGreaterThan(0);
    expect(analysis.timelineSummary.length).toBeGreaterThan(0);
    expect(analysis.meanGrayTimeline).toBeUndefined();
    expect(
      analysis.samples.some((sample) => sample.label === "first_black"),
    ).toBe(true);
    expect(
      analysis.samples.some((sample) => sample.label === "mark_0_press-a"),
    ).toBe(true);
  });

  it("includes the full timeline only when requested", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polyscreen-analyze-"));
    cleanups.push(async () => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "black-full.mp4");
    await makeClip(path, "black", 0.3);

    const analysis = await analyzeRecording(path, {
      fps: 10,
      includeFullTimeline: true,
    });

    expect(analysis.meanGrayTimeline?.length).toBe(analysis.frameCount);
  });

  it("reports zero black frames for a light clip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polyscreen-analyze-"));
    cleanups.push(async () => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "white.mp4");
    await makeClip(path, "white", 0.3);

    const analysis = await analyzeRecording(path, {
      fps: 10,
      blackThreshold: 40,
    });

    expect(analysis.blackFrameCount).toBe(0);
    expect(analysis.firstBlackOffsetMs).toBeNull();
    expect(
      analysis.bucketCounts.light_app_ui + analysis.bucketCounts.other,
    ).toBe(analysis.frameCount);
  });

  it("flash mode enables sample export and denser timeline", () => {
    expect(resolveAnalyzeOptions({ mode: "flash" })).toMatchObject({
      exportSampleFrames: true,
      timelineDownsampleMs: 100,
      blackThreshold: 16,
    });
  });

  it("collects contiguous black runs", () => {
    const runs = collectThresholdRuns(
      [
        { tMs: 0, mean: 5, bucket: "true_black" },
        { tMs: 100, mean: 5, bucket: "true_black" },
        { tMs: 200, mean: 200, bucket: "light_app_ui" },
        { tMs: 300, mean: 5, bucket: "true_black" },
      ],
      16,
      100,
    );
    expect(runs.frameCount).toBe(3);
    expect(runs.runs).toEqual([
      { startMs: 0, endMs: 100, durationMs: 200 },
      { startMs: 300, endMs: 300, durationMs: 100 },
    ]);
    expect(runs.maxRunMs).toBe(200);
  });

  it("golden: black clip analysis shape stays stable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polyscreen-analyze-"));
    cleanups.push(async () => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "golden-black.mp4");
    await makeClip(path, "black", 0.2);

    const analysis = await analyzeRecording(path, {
      mode: "flash",
      fps: 10,
      artifactRoot: dir,
    });

    expect({
      blackThreshold: analysis.blackThreshold,
      dimThreshold: analysis.dimThreshold,
      blackFrameCount: analysis.blackFrameCount,
      firstBlackOffsetMs: analysis.firstBlackOffsetMs,
      bucketKeys: Object.keys(analysis.bucketCounts).sort(),
      hasTimelineSummary: analysis.timelineSummary.length > 0,
      hasSamples: analysis.samples.length > 0,
      meanGrayTimeline: analysis.meanGrayTimeline,
    }).toEqual({
      blackThreshold: 16,
      dimThreshold: 80,
      blackFrameCount: analysis.frameCount,
      firstBlackOffsetMs: 0,
      bucketKeys: [
        "dark_app_ui",
        "light_app_ui",
        "near_black_content",
        "other",
        "system_launcher_idle",
        "true_black",
      ],
      hasTimelineSummary: true,
      hasSamples: true,
      meanGrayTimeline: undefined,
    });
  });

  it("resolves artifact URIs under the artifact root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polyscreen-analyze-"));
    cleanups.push(async () => rm(dir, { recursive: true, force: true }));
    const resolved = await resolveRecordingPath(
      { artifactUri: "mobile://artifacts/demo%20clip.mp4" },
      dir,
    );
    expect(resolved).toBe(join(dir, "demo clip.mp4"));
  });

  it("rejects path-escaping artifact URIs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polyscreen-analyze-"));
    cleanups.push(async () => rm(dir, { recursive: true, force: true }));
    await expect(
      resolveRecordingPath(
        { artifactUri: "mobile://artifacts/..%2Fsecret.mp4" },
        dir,
      ),
    ).rejects.toThrow(/Invalid artifactUri|escapes/);
  });
});
