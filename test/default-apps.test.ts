import { describe, expect, it } from "vitest";

import { AdbProfiles } from "../src/android/adb-profiles.js";
import {
  filterRoles,
  parseRoleDumpsys,
  resolveRoleName,
} from "../src/android/default-apps.js";
import { FakeAdbRunner } from "./fake-adb.js";

const ROLE_DUMP = `
ROLE STATE (dumpsys role):
{
  user_states={
    user_id=0
    roles=[
      {
        name=android.app.role.HOME
        holders=com.example.launcher
      }
      {
        name=android.app.role.BROWSER
        holders=com.android.chrome
      }
      {
        name=android.app.role.SMS
      }
      {
        name=android.app.role.SYSTEM_SHELL
        holders=com.android.shell
      }
    ]
  }
  user_states={
    user_id=10
    roles=[
      {
        name=android.app.role.HOME
        holders=com.other.home
      }
    ]
  }
}
`;

describe("default app roles", () => {
  it("resolves short names and full role names", () => {
    expect(resolveRoleName("home")).toBe("android.app.role.HOME");
    expect(resolveRoleName("BROWSER")).toBe("android.app.role.BROWSER");
    expect(resolveRoleName("android.app.role.DIALER")).toBe(
      "android.app.role.DIALER",
    );
    expect(() => resolveRoleName("not-a-role")).toThrow(/Invalid role/);
  });

  it("parses dumpsys role and scopes by userId", () => {
    const user0 = parseRoleDumpsys(ROLE_DUMP, 0);
    expect(user0).toEqual(
      expect.arrayContaining([
        {
          role: "android.app.role.HOME",
          alias: "home",
          holders: ["com.example.launcher"],
        },
        {
          role: "android.app.role.BROWSER",
          alias: "browser",
          holders: ["com.android.chrome"],
        },
        {
          role: "android.app.role.SMS",
          alias: "sms",
          holders: [],
        },
        {
          role: "android.app.role.SYSTEM_SHELL",
          holders: ["com.android.shell"],
        },
      ]),
    );
    expect(parseRoleDumpsys(ROLE_DUMP, 10)).toEqual([
      {
        role: "android.app.role.HOME",
        alias: "home",
        holders: ["com.other.home"],
      },
    ]);
  });

  it("filters to common non-empty roles by default", () => {
    const filtered = filterRoles(parseRoleDumpsys(ROLE_DUMP, 0));
    expect(filtered.map((role) => role.role)).toEqual([
      "android.app.role.HOME",
      "android.app.role.BROWSER",
    ]);
  });

  it("lists common default apps from dumpsys role", async () => {
    const runner = new FakeAdbRunner().respond(
      ["shell", "dumpsys", "role"],
      ROLE_DUMP,
      { serial: "serial" },
    );
    const profiles = new AdbProfiles(runner, { hostRoot: process.cwd() });

    await expect(
      profiles.listDefaultApps("serial", { userId: 0 }),
    ).resolves.toMatchObject({
      userId: 0,
      roles: [
        {
          role: "android.app.role.HOME",
          holders: ["com.example.launcher"],
        },
        {
          role: "android.app.role.BROWSER",
          holders: ["com.android.chrome"],
        },
      ],
    });
  });

  it("sets a default app through validated cmd role calls", async () => {
    const runner = new FakeAdbRunner()
      .respond(
        [
          "shell",
          "cmd",
          "role",
          "clear-role-holders",
          "--user",
          "0",
          "android.app.role.HOME",
        ],
        "",
        { serial: "serial" },
      )
      .respond(
        [
          "shell",
          "cmd",
          "role",
          "add-role-holder",
          "--user",
          "0",
          "android.app.role.HOME",
          "com.new.launcher",
        ],
        "",
        { serial: "serial" },
      )
      .respond(
        ["shell", "dumpsys", "role"],
        ROLE_DUMP.replace("com.example.launcher", "com.new.launcher"),
        { serial: "serial" },
      );
    const profiles = new AdbProfiles(runner, { hostRoot: process.cwd() });

    const set = await profiles.setDefaultApp("serial", {
      userId: 0,
      role: "home",
      packageName: "com.new.launcher",
    });
    expect(set.holders).toEqual(["com.new.launcher"]);
    expect(runner.calls.map((call) => call.args.slice(0, 4))).toEqual(
      expect.arrayContaining([
        ["shell", "cmd", "role", "clear-role-holders"],
        ["shell", "cmd", "role", "add-role-holder"],
      ]),
    );
  });

  it("rejects unsafe package and component inputs before ADB", async () => {
    const profiles = new AdbProfiles(new FakeAdbRunner(), {
      hostRoot: process.cwd(),
    });
    await expect(
      profiles.setDefaultApp("serial", {
        userId: 0,
        role: "home",
        packageName: "com.evil; reboot",
      }),
    ).rejects.toThrow(/Invalid package/);
    await expect(
      profiles.setDefaultApp("serial", {
        userId: 0,
        role: "browser",
        packageName: "com.example.browser",
        homeComponent: "com.example/.Main",
      }),
    ).rejects.toThrow(/homeComponent is only valid/);
  });

  it("clears a single role holder", async () => {
    const runner = new FakeAdbRunner()
      .respond(
        [
          "shell",
          "cmd",
          "role",
          "remove-role-holder",
          "--user",
          "0",
          "android.app.role.BROWSER",
          "com.android.chrome",
        ],
        "",
        { serial: "serial" },
      )
      .respond(
        ["shell", "dumpsys", "role"],
        ROLE_DUMP.replace(
          "name=android.app.role.BROWSER\n        holders=com.android.chrome",
          "name=android.app.role.BROWSER",
        ),
        { serial: "serial" },
      );
    const profiles = new AdbProfiles(runner, { hostRoot: process.cwd() });
    const cleared = await profiles.clearDefaultApp("serial", {
      userId: 0,
      role: "browser",
      packageName: "com.android.chrome",
    });
    expect(cleared.holders).toEqual([]);
  });
});
