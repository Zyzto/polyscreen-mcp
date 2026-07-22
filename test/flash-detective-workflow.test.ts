import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { summarizeFocusChanges } from "../src/android/focus-sessions.js";
import {
  analyzeRecording,
  classifyMeanGray,
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

/**
 * Golden path for the device-agnostic flash detective workflow:
 * synthetic black clip + marks + flash analyze + focus change asserts.
 * Uses no OEM-specific serials, display IDs, or package names as contracts.
 */
describe("flash detective workflow (generic fixture)", () => {
  it("proves a black flash and a brief wrong-task focus race from structured JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polyscreen-workflow-"));
    cleanups.push(async () => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "transition.mp4");
    await makeClip(path, "black", 0.3);
    await writeFile(
      join(dir, "transition.marks.json"),
      JSON.stringify({
        marks: [
          { label: "pre-input", offsetMs: 0 },
          { label: "post-input", offsetMs: 150 },
        ],
      }),
    );

    const analysis = await analyzeRecording(path, {
      mode: "flash",
      fps: 10,
      artifactRoot: dir,
    });

    expect(analysis.hasBlackFlash).toBe(true);
    expect(analysis.blackFrameCount).toBeGreaterThan(0);
    expect(analysis.bucketCounts.true_black).toBeGreaterThan(0);
    expect(analysis.meanGrayTimeline).toBeUndefined();
    expect(
      analysis.samples.some((sample) => sample.label === "first_black"),
    ).toBe(true);
    expect(
      analysis.samples.some((sample) => sample.label.startsWith("mark_")),
    ).toBe(true);

    // Focus race: another package briefly owns a logical display.
    const changes = summarizeFocusChanges([
      {
        tMs: 0,
        wallClockIso: "2026-01-01T00:00:00.000Z",
        recordOffsetMs: 0,
        displays: {
          "0": {
            packageName: "com.example.app",
            activity: "com.example.app/.MainActivity",
          },
        },
      },
      {
        tMs: 100,
        wallClockIso: "2026-01-01T00:00:00.100Z",
        recordOffsetMs: 100,
        displays: {
          "0": {
            packageName: "com.android.launcher3",
            activity: "com.android.launcher3/.Launcher",
          },
        },
      },
      {
        tMs: 200,
        wallClockIso: "2026-01-01T00:00:00.200Z",
        recordOffsetMs: 200,
        displays: {
          "0": {
            packageName: "com.example.app",
            activity: "com.example.app/.MainActivity",
          },
        },
      },
    ]);
    expect(changes.length).toBeGreaterThanOrEqual(2);
    expect(
      changes.some(
        (change) =>
          change.displays["0"]?.to.packageName === "com.android.launcher3",
      ),
    ).toBe(true);

    // Idle mid-gray chrome is not classified as true black.
    expect(classifyMeanGray(40)).toBe("system_launcher_idle");
    expect(classifyMeanGray(5)).toBe("true_black");
  });
});
