import { describe, expect, it } from "vitest";

import { AndroidController } from "../src/android/android-controller.js";
import { FakeAdbRunner } from "./fake-adb.js";

describe("mobile_devices_list reachability", () => {
  it("prefers a reachable TCP serial over an mDNS twin", async () => {
    const runner = new FakeAdbRunner()
      .respond(
        ["devices", "-l"],
        [
          "List of devices attached",
          "10.0.0.174:5555 device product:HandheldX model:DualPad device:dualpad transport_id:7",
          "adb-HandheldX-xxx._adb-tls-connect._tcp device product:HandheldX model:DualPad device:dualpad transport_id:8",
          "",
        ].join("\n"),
      )
      .respond(["get-state"], "device", { serial: "10.0.0.174:5555" })
      .respond(["shell", "getprop", "ro.serialno"], "HWABC123", {
        serial: "10.0.0.174:5555",
      })
      .respond(["get-state"], "device", {
        serial: "adb-HandheldX-xxx._adb-tls-connect._tcp",
      })
      .respond(["shell", "getprop", "ro.serialno"], "HWABC123", {
        serial: "adb-HandheldX-xxx._adb-tls-connect._tcp",
      });

    const devices = await new AndroidController(runner).listDevices();

    expect(devices).toHaveLength(2);
    const tcp = devices.find((device) => device.serial === "10.0.0.174:5555");
    const mdns = devices.find((device) =>
      device.serial.includes("_adb-tls-connect._tcp"),
    );
    expect(tcp).toMatchObject({
      reachable: true,
      preferred: true,
      preferredSerial: "10.0.0.174:5555",
      hardwareSerial: "HWABC123",
      aliases: ["adb-HandheldX-xxx._adb-tls-connect._tcp"],
    });
    expect(mdns).toMatchObject({
      reachable: true,
      preferred: false,
      preferredSerial: "10.0.0.174:5555",
      hardwareSerial: "HWABC123",
      aliases: ["10.0.0.174:5555"],
    });
    expect(devices[0]?.serial).toBe("10.0.0.174:5555");
  });

  it("does not alias devices that lack hardwareSerial", async () => {
    const runner = new FakeAdbRunner().respond(
      ["devices", "-l"],
      [
        "List of devices attached",
        "offline-a offline product:X model:Y device:z",
        "offline-b offline product:X model:Y device:z",
        "",
      ].join("\n"),
    );

    const devices = await new AndroidController(runner).listDevices();
    expect(devices).toHaveLength(2);
    expect(devices.every((device) => device.aliases?.length === 0)).toBe(true);
    expect(
      devices.every((device) => device.preferredSerial === device.serial),
    ).toBe(true);
  });

  it("does not mark unreachable twins as preferred", async () => {
    const runner = new FakeAdbRunner().respond(
      ["devices", "-l"],
      [
        "List of devices attached",
        "10.0.0.1:5555 device product:X model:Y device:z",
        "adb-twin._adb-tls-connect._tcp device product:X model:Y device:z",
        "",
      ].join("\n"),
    );

    const original = runner.run.bind(runner);
    runner.run = async (args, options = {}) => {
      if (args[0] === "get-state") {
        throw Object.assign(new Error("offline"), {
          result: {
            argv: [...args],
            stdout: Buffer.alloc(0),
            stderr: Buffer.from("offline"),
            exitCode: 1,
            durationMs: 1,
          },
        });
      }
      if (args[0] === "shell" && args[1] === "getprop") {
        return {
          argv: [...args],
          stdout: Buffer.from("HW999\n"),
          stderr: Buffer.alloc(0),
          exitCode: 0,
          durationMs: 1,
        };
      }
      return original(args, options);
    };

    const devices = await new AndroidController(runner).listDevices();
    expect(devices).toHaveLength(2);
    expect(devices.every((device) => device.hardwareSerial === "HW999")).toBe(
      true,
    );
    expect(devices.every((device) => device.reachable === false)).toBe(true);
    expect(devices.every((device) => device.preferred === false)).toBe(true);
    expect(devices[0]?.preferredSerial).toBe(devices[1]?.preferredSerial);
  });

  it("marks unreachable serials", async () => {
    const runner = new FakeAdbRunner()
      .respond(
        ["devices", "-l"],
        "List of devices attached\nstale:5555 device product:HandheldX model:DualPad device:dualpad\n",
      )
      .respond(["get-state"], "", {
        serial: "stale:5555",
        exitCode: 1,
        stderr: "error: device offline",
      });

    // FakeAdbRunner returns exitCode in response but still resolves; simulate failure.
    const original = runner.run.bind(runner);
    runner.run = async (args, options = {}) => {
      if (args[0] === "get-state") {
        throw Object.assign(new Error("device offline"), {
          result: {
            argv: [...args],
            stdout: Buffer.alloc(0),
            stderr: Buffer.from("offline"),
            exitCode: 1,
            durationMs: 1,
          },
        });
      }
      return original(args, options);
    };

    const devices = await new AndroidController(runner).listDevices();
    expect(devices[0]).toMatchObject({
      serial: "stale:5555",
      reachable: false,
    });
  });

  it("rejects unreachable serials in requireDevice", async () => {
    const runner = new FakeAdbRunner().respond(
      ["devices", "-l"],
      "List of devices attached\nstale:5555 device product:X model:Y device:z\n",
    );
    const original = runner.run.bind(runner);
    runner.run = async (args, options = {}) => {
      if (args[0] === "get-state") {
        throw Object.assign(new Error("offline"), {
          result: {
            argv: [...args],
            stdout: Buffer.alloc(0),
            stderr: Buffer.from("offline"),
            exitCode: 1,
            durationMs: 1,
          },
        });
      }
      return original(args, options);
    };

    await expect(
      new AndroidController(runner).requireDevice("stale:5555"),
    ).rejects.toThrow(/not reachable/);
  });
});
