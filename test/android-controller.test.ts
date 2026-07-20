import { describe, expect, it } from "vitest";

import { AndroidController } from "../src/android/android-controller.js";
import { addConnectedDevice, FakeAdbRunner } from "./fake-adb.js";

const SERIAL = "serial-1";
const DISPLAY_DUMP = `
  Logical Displays: size=3
    Display 0:
      mDisplayId=0
      mBaseDisplayInfo=DisplayInfo{"Top", displayId 0", real 1080 x 1920, rotation 0, state ON, uniqueId "local:111111111111111111", density 320}
      mOverrideDisplayInfo=DisplayInfo{"Top", displayId 0", real 1920 x 1080, rotation 1, state OFF, uniqueId "local:111111111111111111", density 320}
    Display 4:
      mDisplayId=4
      mBaseDisplayInfo=DisplayInfo{"Bottom", displayId 4", real 1080 x 1240, rotation 0, state ON, uniqueId "local:222222222222222222", density 320}
      mOverrideDisplayInfo=DisplayInfo{"Bottom", displayId 4", real 1240 x 1080, rotation 1, state OFF, uniqueId "local:222222222222222222", density 320}
    Display 8:
      mDisplayId=8
      mBaseDisplayInfo=DisplayInfo{"Virtual", displayId 8", real 800 x 600, rotation 0, state ON, uniqueId "virtual:owner,Virtual,0", density 240}
`;

const WINDOW_DUMP = `
  Display: mDisplayId=4
    mCurrentFocus=Window{abc u0 com.example/com.example.BottomActivity}
    mFocusedApp=ActivityRecord{def u0 com.example/.BottomActivity} t1}
  Display: mDisplayId=0
    mCurrentFocus=Window{ghi u0 com.game/com.game.MainActivity}
    mFocusedApp=ActivityRecord{jkl u0 com.game/.MainActivity} t2}
`;

function displayRunner(): FakeAdbRunner {
  return addConnectedDevice(new FakeAdbRunner())
    .respond(["shell", "dumpsys", "display"], DISPLAY_DUMP, { serial: SERIAL })
    .respond(
      ["shell", "dumpsys", "SurfaceFlinger", "--display-id"],
      "Display 111111111111111111\nDisplay 222222222222222222\n",
      { serial: SERIAL },
    )
    .respond(["shell", "dumpsys", "window", "displays"], WINDOW_DUMP, {
      serial: SERIAL,
    });
}

describe("AndroidController", () => {
  it("separates logical, physical, and virtual displays", async () => {
    const controller = new AndroidController(displayRunner());
    const displays = await controller.listDisplays(SERIAL);

    expect(displays).toMatchObject([
      {
        logicalId: 0,
        physicalId: "111111111111111111",
        state: "ON",
        width: 1920,
        height: 1080,
        focusedActivity: "com.game/.MainActivity",
      },
      {
        logicalId: 4,
        physicalId: "222222222222222222",
        state: "ON",
        focusedWindow: "com.example/com.example.BottomActivity",
      },
      {
        logicalId: 8,
        uniqueId: "virtual:owner,Virtual,0",
      },
    ]);
    expect(displays[2]?.physicalId).toBeUndefined();
  });

  it("captures a requested display through its physical ID", async () => {
    const runner = displayRunner();
    const png = Buffer.concat([
      Buffer.from([0x89]),
      Buffer.from("PNG\r\nfixture"),
    ]);
    runner.respond(
      ["exec-out", "screencap", "-p", "-d", "222222222222222222"],
      png,
      { serial: SERIAL },
    );
    const controller = new AndroidController(runner);

    const capture = await controller.captureScreen(SERIAL, 4);

    expect(capture.png).toEqual(png);
    expect(capture.display.logicalId).toBe(4);
  });

  it("refuses to capture a virtual display instead of using the wrong screen", async () => {
    const controller = new AndroidController(displayRunner());
    await expect(controller.captureScreen(SERIAL, 8)).rejects.toThrow(
      "has no correlated physical ID",
    );
  });

  it("does not implicitly capture display 0 when physical correlation is ambiguous", async () => {
    const uncorrelatedDump = DISPLAY_DUMP.replaceAll(
      "local:111111111111111111",
      "local:999",
    ).replaceAll("local:222222222222222222", "local:998");
    const runner = addConnectedDevice(new FakeAdbRunner())
      .respond(["shell", "dumpsys", "display"], uncorrelatedDump, {
        serial: SERIAL,
      })
      .respond(
        ["shell", "dumpsys", "SurfaceFlinger", "--display-id"],
        "Display 111111111111111111\nDisplay 222222222222222222\n",
        { serial: SERIAL },
      )
      .respond(["shell", "dumpsys", "window", "displays"], WINDOW_DUMP, {
        serial: SERIAL,
      });

    await expect(
      new AndroidController(runner).captureScreen(SERIAL, 0),
    ).rejects.toThrow("has no correlated physical ID");
  });

  it("verifies the observed focused display after launch", async () => {
    const runner = displayRunner()
      .respond(
        [
          "shell",
          "cmd",
          "package",
          "resolve-activity",
          "--brief",
          "-a",
          "android.intent.action.MAIN",
          "-c",
          "android.intent.category.LAUNCHER",
          "com.example",
        ],
        "com.example/.BottomActivity",
        { serial: SERIAL },
      )
      .respond(
        [
          "shell",
          "am",
          "start",
          "-W",
          "--display",
          "4",
          "-n",
          "com.example/.BottomActivity",
        ],
        "Status: ok",
        { serial: SERIAL },
      );
    const controller = new AndroidController(runner);

    const result = await controller.launchApp(SERIAL, "com.example", 4);

    expect(result.data).toMatchObject({
      requestedDisplayId: 4,
      observedFocusedDisplayId: 4,
    });
    expect(result.warnings).toEqual([]);
  });

  it("preserves a fully-qualified explicit activity name", async () => {
    const runner = displayRunner().respond(
      [
        "shell",
        "am",
        "start",
        "-W",
        "--display",
        "4",
        "-n",
        "com.example/com.example.MainActivity",
      ],
      "Status: ok",
      { serial: SERIAL },
    );
    const controller = new AndroidController(runner);

    const result = await controller.launchApp(
      SERIAL,
      "com.example",
      4,
      "com.example.MainActivity",
    );

    expect(result.data.component).toBe("com.example/com.example.MainActivity");
  });
});
