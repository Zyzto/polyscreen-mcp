import { describe, expect, it } from "vitest";

import { AdbProfiles } from "../src/android/adb-profiles.js";
import { FakeAdbRunner } from "./fake-adb.js";

describe("ADB profile validation", () => {
  const profiles = new AdbProfiles(new FakeAdbRunner(), {
    hostRoot: process.cwd(),
  });

  it("rejects broadcast command injection before invoking ADB", async () => {
    await expect(
      profiles.sendBroadcast("serial", {
        action: "com.example.ACTION;reboot",
        userId: 0,
        extras: {},
      }),
    ).rejects.toThrow("Invalid intent action");
  });

  it("uses the enabled-only filter unless disabled packages are requested", async () => {
    const runner = new FakeAdbRunner()
      .respond(
        ["shell", "pm", "list", "packages", "--user", "0", "-e"],
        "package:com.example.enabled",
        { serial: "serial" },
      )
      .respond(
        ["shell", "pm", "list", "packages", "--user", "0"],
        "package:com.example.enabled\npackage:com.example.disabled",
        { serial: "serial" },
      );
    const safeProfiles = new AdbProfiles(runner, { hostRoot: process.cwd() });

    await expect(
      safeProfiles.listPackages("serial", {
        userId: 0,
        thirdPartyOnly: false,
        includeDisabled: false,
      }),
    ).resolves.toEqual(["com.example.enabled"]);
    await expect(
      safeProfiles.listPackages("serial", {
        userId: 0,
        thirdPartyOnly: false,
        includeDisabled: true,
      }),
    ).resolves.toEqual(["com.example.disabled", "com.example.enabled"]);
  });

  it("quotes broadcast values before the device shell parses them", async () => {
    const runner = new FakeAdbRunner().respond(
      [
        "shell",
        "am",
        "broadcast",
        "--user",
        "0",
        "-a",
        "com.example.ACTION",
        "--es",
        "value",
        "'hello; id'",
      ],
      "Broadcast completed",
      { serial: "serial" },
    );
    const safeProfiles = new AdbProfiles(runner, { hostRoot: process.cwd() });

    await safeProfiles.sendBroadcast("serial", {
      action: "com.example.ACTION",
      userId: 0,
      extras: { value: "hello; id" },
    });

    expect(runner.calls).toHaveLength(1);
  });

  it("rejects malformed permission names", async () => {
    await expect(
      profiles.permission("serial", {
        action: "grant",
        packageName: "com.example",
        permission: "android.permission.CAMERA --user 10",
        userId: 0,
      }),
    ).rejects.toThrow("Invalid permission name");
  });

  it("restricts remote paths to approved roots", async () => {
    await expect(
      profiles.pull("serial", "/data/local/tmp/../../data/system/users.xml"),
    ).rejects.toThrow("Remote path must remain under");
    await expect(
      profiles.pull("serial", "/data/data/com.example/database"),
    ).rejects.toThrow("Remote path must remain under");
  });

  it("prevents host path escapes on push", async () => {
    await expect(
      profiles.push("serial", "/etc/hosts", "/data/local/tmp/hosts"),
    ).rejects.toThrow("Host path must remain under");
  });

  it("validates logcat filters", async () => {
    await expect(
      profiles.logcat("serial", {
        buffer: "main",
        lines: 10,
        tags: ["Tag;reboot"],
        minimumPriority: "I",
      }),
    ).rejects.toThrow("Invalid logcat tag");
    await expect(
      profiles.logcat("serial", {
        buffer: "main",
        lines: 10,
        tags: ["Tag:D"],
        minimumPriority: "I",
      }),
    ).rejects.toThrow("Invalid logcat tag");
  });
});
