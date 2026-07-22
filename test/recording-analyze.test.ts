import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  analyzeRecording,
  classifyMeanGray,
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
      blackThreshold: 40,
      exportSampleFrames: true,
      artifactRoot: dir,
    });

    expect(analysis.blackFrameCount).toBeGreaterThan(0);
    expect(analysis.firstBlackOffsetMs).toBe(0);
    expect(analysis.marks).toEqual([{ label: "press-a", offsetMs: 100 }]);
    expect(analysis.bucketCounts.true_black).toBeGreaterThan(0);
    expect(
      analysis.samples.some((sample) => sample.label === "first_black"),
    ).toBe(true);
    expect(
      analysis.samples.some((sample) => sample.label === "mark_press-a"),
    ).toBe(true);
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

  it("resolves artifact URIs under the artifact root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polyscreen-analyze-"));
    cleanups.push(async () => rm(dir, { recursive: true, force: true }));
    const resolved = await resolveRecordingPath(
      { artifactUri: "mobile://artifacts/demo%20clip.mp4" },
      dir,
    );
    expect(resolved).toBe(join(dir, "demo clip.mp4"));
  });
});
