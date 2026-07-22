import { describe, expect, it } from "vitest";

import { AndroidController } from "../src/android/android-controller.js";
import { FocusTraceSessionManager } from "../src/android/focus-sessions.js";
import { parseWindowFocus } from "../src/android/parsers.js";
import { addConnectedDevice, FakeAdbRunner } from "./fake-adb.js";

const SERIAL = "serial-1";

const WINDOW_DUMP = `
  Display: mDisplayId=4
    mCurrentFocus=Window{abc u0 com.android.launcher3/com.android.launcher3.SecondaryDisplayLauncher}
    mFocusedApp=ActivityRecord{def u0 com.android.launcher3/.SecondaryDisplayLauncher} t9}
  Display: mDisplayId=0
    mCurrentFocus=Window{ghi u0 com.example.game/com.example.game.MainActivity}
    mFocusedApp=ActivityRecord{jkl u0 com.example.game/.MainActivity} t3}
`;

describe("focus tracing", () => {
  it("parses package, activity, and taskId from window dumps", () => {
    expect(parseWindowFocus(WINDOW_DUMP)).toEqual([
      {
        logicalId: 0,
        focusedWindow: "com.example.game/com.example.game.MainActivity",
        focusedActivity: "com.example.game/.MainActivity",
        focusedPackage: "com.example.game",
        focusedTaskId: 3,
      },
      {
        logicalId: 4,
        focusedWindow:
          "com.android.launcher3/com.android.launcher3.SecondaryDisplayLauncher",
        focusedActivity: "com.android.launcher3/.SecondaryDisplayLauncher",
        focusedPackage: "com.android.launcher3",
        focusedTaskId: 9,
      },
    ]);
  });

  it("samples a multi-display focus timeline via runFor", async () => {
    const runner = addConnectedDevice(new FakeAdbRunner())
      .respond(["get-state"], "device", { serial: SERIAL })
      .respond(["shell", "getprop", "ro.serialno"], "HW123", {
        serial: SERIAL,
      })
      .respond(["shell", "dumpsys", "window", "displays"], WINDOW_DUMP, {
        serial: SERIAL,
      });
    const manager = new FocusTraceSessionManager(new AndroidController(runner));

    const trace = await manager.runFor(SERIAL, [0, 4], 250, 80);

    expect(trace.sampleCount).toBeGreaterThanOrEqual(1);
    expect(trace.samples[0]?.displays["4"]).toMatchObject({
      packageName: "com.android.launcher3",
      activity: "com.android.launcher3/.SecondaryDisplayLauncher",
      taskId: 9,
    });
    expect(trace.samples[0]?.displays["0"]).toMatchObject({
      packageName: "com.example.game",
      taskId: 3,
    });
  });
});
