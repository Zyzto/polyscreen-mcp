import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cmdlineLooksLikeScreenrecord,
  RecordingSessionManager,
} from "../src/android/record-sessions.js";
import { FakeAdbRunner } from "./fake-adb.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("RecordingSessionManager", () => {
  it("accepts only screenrecord cmdlines for the session path", () => {
    expect(
      cmdlineLooksLikeScreenrecord(
        "screenrecord\0--display-id\0/data/local/tmp/recording-1.mp4\0",
        "/data/local/tmp/recording-1.mp4",
      ),
    ).toBe(true);
    expect(
      cmdlineLooksLikeScreenrecord(
        "screenrecord\0/data/local/tmp/other.mp4\0",
        "/data/local/tmp/recording-1.mp4",
      ),
    ).toBe(false);
    expect(
      cmdlineLooksLikeScreenrecord("bash\0", "/data/local/tmp/recording-1.mp4"),
    ).toBe(false);
  });

  it("rejects invalid mark labels and unknown sessions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polyscreen-record-"));
    cleanups.push(async () => rm(dir, { recursive: true, force: true }));
    const manager = new RecordingSessionManager(new FakeAdbRunner(), dir);

    expect(() =>
      manager.mark(
        "serial",
        "00000000-0000-4000-8000-000000000000",
        "bad label",
      ),
    ).toThrow("Unknown recording session");
  });

  it("starts on-device screenrecord, records marks, and pulls on stop", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polyscreen-record-"));
    cleanups.push(async () => rm(dir, { recursive: true, force: true }));

    const runner = new FakeAdbRunner();
    const manager = new RecordingSessionManager(runner, dir);
    const physicalDisplayId = "222222222222222222";

    // First shell starts screenrecord and returns PID.
    runner.run = async (args, options = {}) => {
      runner.calls.push({ args: [...args], options });
      if (args[0] === "shell" && args[1] === "sh" && args[2] === "-c") {
        return {
          argv: [...args],
          stdout: Buffer.from("4242\n"),
          stderr: Buffer.alloc(0),
          exitCode: 0,
          durationMs: 1,
        };
      }
      if (
        args[0] === "shell" &&
        args[1] === "cat" &&
        typeof args[2] === "string" &&
        args[2].startsWith("/proc/")
      ) {
        // Alive with matching cmdline until SIGINT, then gone.
        const intSent = runner.calls.some(
          (call) =>
            call.args[0] === "shell" &&
            call.args[1] === "kill" &&
            call.args[2] === "-INT",
        );
        if (intSent) {
          throw Object.assign(new Error("No such file"), {
            result: {
              argv: [...args],
              stdout: Buffer.alloc(0),
              stderr: Buffer.from("No such file"),
              exitCode: 1,
              durationMs: 1,
            },
          });
        }
        const remote = String(
          runner.calls.find(
            (call) =>
              call.args[0] === "shell" &&
              call.args[1] === "sh" &&
              call.args[2] === "-c",
          )?.args[3] ?? "",
        ).match(/(\/data\/local\/tmp\/[^'\s]+)/)?.[1];
        return {
          argv: [...args],
          stdout: Buffer.from(`screenrecord\0--display-id\0${remote ?? "x"}\0`),
          stderr: Buffer.alloc(0),
          exitCode: 0,
          durationMs: 1,
        };
      }
      if (args[0] === "shell" && args[1] === "kill" && args[2] === "-0") {
        const intSent = runner.calls.some(
          (call) =>
            call.args[0] === "shell" &&
            call.args[1] === "kill" &&
            call.args[2] === "-INT",
        );
        if (intSent) {
          throw Object.assign(new Error("not running"), {
            result: {
              argv: [...args],
              stdout: Buffer.alloc(0),
              stderr: Buffer.from("No such process"),
              exitCode: 1,
              durationMs: 1,
            },
          });
        }
        return {
          argv: [...args],
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          exitCode: 0,
          durationMs: 1,
        };
      }
      if (args[0] === "shell" && args[1] === "kill" && args[2] === "-INT") {
        return {
          argv: [...args],
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          exitCode: 0,
          durationMs: 1,
        };
      }
      if (args[0] === "pull") {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(args[2]!, Buffer.from("fake-mp4"));
        return {
          argv: [...args],
          stdout: Buffer.from("pulled"),
          stderr: Buffer.alloc(0),
          exitCode: 0,
          durationMs: 1,
        };
      }
      if (args[0] === "shell" && args[1] === "rm") {
        return {
          argv: [...args],
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          exitCode: 0,
          durationMs: 1,
        };
      }
      throw new Error(`Unexpected fake ADB call: ${args.join(" ")}`);
    };

    const started = await manager.start("serial", 4, physicalDisplayId);
    expect(started.recordId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(started.physicalDisplayId).toBe(physicalDisplayId);

    const mark = manager.mark("serial", started.recordId, "press-a");
    expect(mark.label).toBe("press-a");
    expect(mark.offsetMs).toBeGreaterThanOrEqual(0);
    expect(mark.wallClockIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await expect(manager.start("serial", 4, physicalDisplayId)).rejects.toThrow(
      "Recording already active",
    );

    const stopped = await manager.stop("serial", started.recordId);
    expect(stopped.marks).toEqual([mark]);
    expect(stopped.path).toContain(".mp4");
    expect(stopped.artifactUri.startsWith("mobile://artifacts/")).toBe(true);
    expect(stopped.sizeBytes).toBeGreaterThan(0);
  });
});
