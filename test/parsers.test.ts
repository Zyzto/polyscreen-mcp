import { describe, expect, it } from "vitest";

import {
  correlatePhysicalDisplays,
  parseDevices,
  parseInputCapabilities,
  parseLogicalDisplays,
  parsePhysicalDisplays,
  parseProperties,
} from "../src/android/parsers.js";

describe("ADB parsers", () => {
  it("parses device metadata without guessing a default", () => {
    expect(
      parseDevices(
        "List of devices attached\n10.0.0.174:5555 device product:Thor model:AYN_Thor device:thor transport_id:7\n",
      ),
    ).toEqual([
      {
        serial: "10.0.0.174:5555",
        state: "device",
        product: "Thor",
        model: "AYN_Thor",
        device: "thor",
        transportId: "7",
      },
    ]);
  });

  it("parses getprop output", () => {
    expect(
      parseProperties(
        "[ro.build.version.sdk]: [33]\n[ro.product.manufacturer]: [AYN]\n[empty]: []\n",
      ),
    ).toEqual({
      "ro.build.version.sdk": "33",
      "ro.product.manufacturer": "AYN",
      empty: "",
    });
  });

  it("derives input support from device help rather than API level", () => {
    const capabilities = parseInputCapabilities(`
      input [<source>] [-d DISPLAY_ID] <command>
      keyevent [--longpress] [--doubletap] [--duration <ms>]
      tap
      swipe
      draganddrop
      motionevent
      keycombination
      scroll
      Sources: keyboard dpad gamepad touchscreen
    `);
    expect(capabilities.displayTargeting).toBe(true);
    expect(capabilities.commands.keyCombination).toBe(true);
    expect(capabilities.keyOptions.duration).toBe(true);
    expect(capabilities.sources).toContain("gamepad");
  });

  it("keeps physical IDs as strings and correlates local unique IDs", () => {
    const logical = parseLogicalDisplays(`
      Display 0
        DisplayInfo{"Built-in", displayId=0, uniqueId="local:21691504607621632", 1920 x 1080, densityDpi=320, state=ON}
      Display 4
        DisplayInfo{"Bottom", displayId=4, uniqueId="local:21691504607621633", 1080 x 1920, densityDpi=320, state=ON}
    `);
    const physical = parsePhysicalDisplays(
      "Display 21691504607621632\nDisplay 21691504607621633\n",
    );
    const displays = correlatePhysicalDisplays(logical, physical);
    expect(displays.map((display) => display.physicalId)).toEqual([
      "21691504607621632",
      "21691504607621633",
    ]);
  });

  it("accepts port-derived physical IDs without a minimum width", () => {
    expect(
      parsePhysicalDisplays(
        "Display 0\nDisplay 255\nDisplay 18446744073709551615\nDisplay 18446744073709551616\n",
      ),
    ).toEqual(["0", "255", "18446744073709551615"]);
  });
});
