import { describe, expect, it } from "vitest";

import { AndroidController } from "../src/android/android-controller.js";
import {
  FocusTraceSessionManager,
  summarizeFocusChanges,
} from "../src/android/focus-sessions.js";
import { addConnectedDevice, FakeAdbRunner } from "./fake-adb.js";

const SERIAL = "serial-1";
const WINDOW_DUMP = `
  Display: mDisplayId=4
    mCurrentFocus=Window{abc u0 com.android.launcher3/com.android.launcher3.SecondaryDisplayLauncher}
    mFocusedApp=ActivityRecord{def u0 com.android.launcher3/.SecondaryDisplayLauncher} t9}
  Display: mDisplayId=0
    mCurrentFocus=Window{ghi u0 com.wajiha/com.wajiha.MainActivity}
    mFocusedApp=ActivityRecord{jkl u0 com.wajiha/.MainActivity} t3}
`;

describe("FocusTraceSessionManager", () => {
  it("samples asynchronously and includes wall-clock fields", async () => {
    const runner = addConnectedDevice(new FakeAdbRunner())
      .respond(["get-state"], "device", { serial: SERIAL })
      .respond(["shell", "getprop", "ro.serialno"], "HW123", {
        serial: SERIAL,
      })
      .respond(["shell", "dumpsys", "window", "displays"], WINDOW_DUMP, {
        serial: SERIAL,
      });
    const manager = new FocusTraceSessionManager(new AndroidController(runner));

    const started = manager.start(SERIAL, [0, 4], 50, {
      boundRecordId: "00000000-0000-4000-8000-000000000001",
      recordStartedAtMs: Date.now() - 200,
    });
    await new Promise((resolve) => setTimeout(resolve, 140));
    const stopped = await manager.stop(SERIAL, started.focusSessionId);

    expect(stopped.sampleCount).toBeGreaterThanOrEqual(1);
    expect(stopped.samples[0]?.wallClockIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(stopped.samples[0]?.recordOffsetMs).toBeGreaterThanOrEqual(0);
    expect(stopped.samples[0]?.displays["4"]?.packageName).toBe(
      "com.android.launcher3",
    );
    expect(stopped.boundRecordId).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("rejects a second concurrent session on the same serial", () => {
    const runner = addConnectedDevice(new FakeAdbRunner()).respond(
      ["shell", "dumpsys", "window", "displays"],
      WINDOW_DUMP,
      { serial: SERIAL },
    );
    const manager = new FocusTraceSessionManager(new AndroidController(runner));
    manager.start(SERIAL, [0], 200);
    expect(() => manager.start(SERIAL, [4], 200)).toThrow(
      "Focus trace already active",
    );
    void manager.stopAll();
  });

  it("summarizes focus transitions across displays", () => {
    const changes = summarizeFocusChanges([
      {
        tMs: 0,
        wallClockIso: "2026-01-01T00:00:00.000Z",
        displays: {
          "4": { packageName: "com.android.launcher3", activity: "L/A" },
        },
      },
      {
        tMs: 100,
        wallClockIso: "2026-01-01T00:00:00.100Z",
        displays: {
          "4": { packageName: "com.android.launcher3", activity: "L/A" },
        },
      },
      {
        tMs: 200,
        wallClockIso: "2026-01-01T00:00:00.200Z",
        displays: {
          "4": { packageName: "com.game", activity: "com.game/.Main" },
        },
      },
    ]);
    expect(changes).toHaveLength(2);
    expect(changes[0]?.displays["4"]?.to.packageName).toBe(
      "com.android.launcher3",
    );
    expect(changes[1]?.displays["4"]).toMatchObject({
      from: { packageName: "com.android.launcher3" },
      to: { packageName: "com.game" },
    });
  });

  it("lists active sessions for status recovery", async () => {
    const runner = addConnectedDevice(new FakeAdbRunner()).respond(
      ["shell", "dumpsys", "window", "displays"],
      WINDOW_DUMP,
      { serial: SERIAL },
    );
    const manager = new FocusTraceSessionManager(new AndroidController(runner));
    const started = manager.start(SERIAL, [0, 4], 200);
    const listed = manager.listActive(SERIAL);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.focusSessionId).toBe(started.focusSessionId);
    expect(listed[0]?.displayIds).toEqual([0, 4]);
    await manager.stopAll();
  });

  it("ring-buffers samples when maxSamples is exceeded", async () => {
    const runner = addConnectedDevice(new FakeAdbRunner())
      .respond(["get-state"], "device", { serial: SERIAL })
      .respond(["shell", "getprop", "ro.serialno"], "HW123", {
        serial: SERIAL,
      })
      .respond(["shell", "dumpsys", "window", "displays"], WINDOW_DUMP, {
        serial: SERIAL,
      });
    const manager = new FocusTraceSessionManager(new AndroidController(runner));
    const started = manager.start(SERIAL, [0], 40, { maxSamples: 3 });
    await new Promise((resolve) => setTimeout(resolve, 220));
    const stopped = await manager.stop(SERIAL, started.focusSessionId);
    expect(stopped.sampleCount).toBeLessThanOrEqual(3);
    expect(stopped.droppedSamples).toBeGreaterThan(0);
    expect(stopped.truncated).toBe(true);
  });
});
