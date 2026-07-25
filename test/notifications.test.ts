import { describe, expect, it } from "vitest";

import { AdbProfiles } from "../src/android/adb-profiles.js";
import {
  parseNotificationKey,
  parseNotificationList,
  parseNotificationRecord,
} from "../src/android/notifications.js";
import { FakeAdbRunner } from "./fake-adb.js";

const LIST_RAW = `
0|dev.imranr.obtainium|5|null|10114
0|com.android.shell|2020|polyscreen-test|2000
-1|android|62|null|1000
`;

const RECORD_RAW = `
NotificationRecord(0x062afed4: pkg=dev.imranr.obtainium user=UserHandle{0} id=5 tag=null importance=2 key=0|dev.imranr.obtainium|5|null|10114: Notification(channel=BG_UPDATE_CHECK_ERROR shortcut=null contentView=null vibrate=null sound=null defaults=0x0 flags=0x10 color=0x00000000 groupKey=dev.imranr.obtainium.BG_UPDATE_CHECK_ERROR vis=PRIVATE))
  uid=10114 userId=0
  opPkg=dev.imranr.obtainium
  key=0|dev.imranr.obtainium|5|null|10114
  seen=false
  notification=
    when=1784939056426
    tickerText=null
    extras={
        android.title=String (Error checking for updates)
        android.text=String (rate limit exceeded)
        android.subText=null
    }
`;

describe("notifications", () => {
  it("parses list keys including system package android", () => {
    expect(parseNotificationList(LIST_RAW)).toEqual([
      {
        key: "0|dev.imranr.obtainium|5|null|10114",
        userId: 0,
        packageName: "dev.imranr.obtainium",
        id: 5,
        tag: null,
        uid: 10114,
      },
      {
        key: "0|com.android.shell|2020|polyscreen-test|2000",
        userId: 0,
        packageName: "com.android.shell",
        id: 2020,
        tag: "polyscreen-test",
        uid: 2000,
      },
      {
        key: "-1|android|62|null|1000",
        userId: -1,
        packageName: "android",
        id: 62,
        tag: null,
        uid: 1000,
      },
    ]);
    expect(parseNotificationKey("not-a-key")).toBeUndefined();
  });

  it("parses notification get records for title and text", () => {
    expect(parseNotificationRecord(RECORD_RAW)).toMatchObject({
      key: "0|dev.imranr.obtainium|5|null|10114",
      packageName: "dev.imranr.obtainium",
      importance: 2,
      channelId: "BG_UPDATE_CHECK_ERROR",
      title: "Error checking for updates",
      text: "rate limit exceeded",
      whenMs: 1784939056426,
      seen: false,
    });
  });

  it("lists and gets notifications with quoted keys", async () => {
    const key = "0|com.android.shell|2020|polyscreen-test|2000";
    const runner = new FakeAdbRunner()
      .respond(["shell", "cmd", "notification", "list"], LIST_RAW, {
        serial: "serial",
      })
      .respond(
        ["shell", "cmd", "notification", "get", `'${key}'`],
        RECORD_RAW.replaceAll("dev.imranr.obtainium", "com.android.shell")
          .replaceAll("id=5", "id=2020")
          .replaceAll("|5|null|10114", "|2020|polyscreen-test|2000")
          .replace(
            "android.title=String (Error checking for updates)",
            "android.title=String (Hello)",
          )
          .replace(
            "android.text=String (rate limit exceeded)",
            "android.text=String (Body)",
          ),
        { serial: "serial" },
      );
    const profiles = new AdbProfiles(runner, { hostRoot: process.cwd() });

    const listed = await profiles.listNotifications("serial", {
      packageName: "com.android.shell",
    });
    expect(listed.count).toBe(1);
    expect(listed.notifications[0]?.tag).toBe("polyscreen-test");

    const got = await profiles.getNotification("serial", key);
    expect(got.title).toBe("Hello");
    expect(got.text).toBe("Body");
  });

  it("posts a notification with quoted text and rediscovers the key", async () => {
    const key = "0|com.android.shell|2020|polyscreen-test|2000";
    const runner = new FakeAdbRunner()
      .respond(
        [
          "shell",
          "cmd",
          "notification",
          "post",
          "-t",
          "'Hello Title'",
          "polyscreen-test",
          "'Hello; body'",
        ],
        "posting:\n  Notification(channel=shell_cmd)",
        { serial: "serial" },
      )
      .respond(["shell", "cmd", "notification", "list"], LIST_RAW, {
        serial: "serial",
      })
      .respond(
        ["shell", "cmd", "notification", "get", `'${key}'`],
        `NotificationRecord(pkg=com.android.shell id=2020 tag=polyscreen-test importance=3 key=${key}: Notification(channel=shell_cmd))
  key=${key}
  seen=false
  notification=
    when=1
    extras={
        android.title=String (Hello Title)
        android.text=String (Hello; body)
    }
`,
        { serial: "serial" },
      );
    const profiles = new AdbProfiles(runner, { hostRoot: process.cwd() });

    const posted = await profiles.postNotification("serial", {
      tag: "polyscreen-test",
      title: "Hello Title",
      text: "Hello; body",
    });
    expect(posted.key).toBe(key);
    expect(posted.notification?.title).toBe("Hello Title");
    expect(posted.notification?.text).toBe("Hello; body");
  });

  it("rejects unsafe tags and keys before ADB", async () => {
    const profiles = new AdbProfiles(new FakeAdbRunner(), {
      hostRoot: process.cwd(),
    });
    await expect(
      profiles.postNotification("serial", {
        tag: "bad tag",
        text: "hi",
      }),
    ).rejects.toThrow(/Invalid notification tag/);
    await expect(
      profiles.getNotification("serial", "0|com.example|1|tag|1; reboot"),
    ).rejects.toThrow(/Invalid notification key/);
  });
});
