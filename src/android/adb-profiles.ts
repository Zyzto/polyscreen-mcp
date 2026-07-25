import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { AdbRunner, quoteRemoteShellArg } from "./adb-runner.js";
import {
  assertSafeComponent,
  assertSafePackage,
  filterRoles,
  parseRoleDumpsys,
  resolveRoleName,
  type RoleHolders,
} from "./default-apps.js";
import { DeviceQueue } from "./device-queue.js";
import {
  assertSafeNotificationKey,
  assertSafeNotificationPackage,
  assertSafeNotificationTag,
  assertSafeNotificationText,
  parseNotificationList,
  parseNotificationRecord,
  type NotificationDetails,
  type NotificationRef,
} from "./notifications.js";
import { abortableDelay } from "../utils/abortable-delay.js";

const SAFE_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
const SAFE_PERMISSION = /^[A-Za-z][A-Za-z0-9_.]+$/;
const SAFE_ACTION = /^[A-Za-z][A-Za-z0-9_.]+$/;
const SAFE_TAG = /^[A-Za-z0-9_./-]{1,128}$/;
const SAFE_REMOTE_ROOTS = [
  "/sdcard/",
  "/storage/emulated/0/",
  "/data/local/tmp/",
];

export class AdbProfiles {
  readonly #queue = new DeviceQueue();
  readonly artifactRoot: string;
  readonly hostRoot: string;

  constructor(
    readonly adb = new AdbRunner(),
    options: { artifactRoot?: string; hostRoot?: string } = {},
  ) {
    this.hostRoot = resolve(options.hostRoot ?? process.cwd());
    this.artifactRoot = resolve(
      options.artifactRoot ??
        join(this.hostRoot, ".polyscreen-mcp", "artifacts"),
    );
  }

  async listPackages(
    serial: string,
    options: {
      userId: number;
      thirdPartyOnly: boolean;
      includeDisabled: boolean;
    },
    signal?: AbortSignal,
  ): Promise<string[]> {
    const args = [
      "shell",
      "pm",
      "list",
      "packages",
      "--user",
      String(options.userId),
    ];
    if (options.thirdPartyOnly) args.push("-3");
    if (!options.includeDisabled) args.push("-e");
    const output = await this.adb.text(args, { serial, signal });
    return output
      .split(/\r?\n/)
      .map((line) => line.replace(/^package:/, "").trim())
      .filter(Boolean)
      .sort();
  }

  async sendBroadcast(
    serial: string,
    input: {
      action: string;
      packageName?: string | undefined;
      userId: number;
      extras: Record<string, string>;
    },
    signal?: AbortSignal,
  ): Promise<string> {
    if (!SAFE_ACTION.test(input.action))
      throw new Error(`Invalid intent action: ${input.action}`);
    if (input.packageName && !SAFE_PACKAGE.test(input.packageName)) {
      throw new Error(`Invalid package: ${input.packageName}`);
    }
    const args = [
      "shell",
      "am",
      "broadcast",
      "--user",
      String(input.userId),
      "-a",
      input.action,
    ];
    if (input.packageName) args.push("-p", input.packageName);
    for (const [key, value] of Object.entries(input.extras)) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(key)) {
        throw new Error(`Invalid extra key: ${key}`);
      }
      args.push("--es", key, quoteRemoteShellArg(value));
    }
    return await this.#queue.mutate(serial, () =>
      this.adb.text(args, { serial, signal }),
    );
  }

  async logcat(
    serial: string,
    input: {
      buffer: "main" | "system" | "crash" | "events" | "radio";
      lines: number;
      tags: string[];
      minimumPriority: "V" | "D" | "I" | "W" | "E" | "F";
    },
    signal?: AbortSignal,
  ): Promise<string> {
    for (const tag of input.tags) {
      if (!SAFE_TAG.test(tag)) throw new Error(`Invalid logcat tag: ${tag}`);
    }
    const args = [
      "shell",
      "logcat",
      "-d",
      "-b",
      input.buffer,
      "-t",
      String(input.lines),
      "-v",
      "threadtime",
    ];
    if (input.tags.length > 0) {
      args.push(
        ...input.tags.map((tag) => `${tag}:${input.minimumPriority}`),
        "*:S",
      );
    } else {
      args.push(`*:${input.minimumPriority}`);
    }
    return await this.adb.text(args, {
      serial,
      signal,
      timeoutMs: 30_000,
      maxOutputBytes: 8 * 1024 * 1024,
    });
  }

  async performance(
    serial: string,
    packageName: string | undefined,
    signal?: AbortSignal,
  ): Promise<Record<string, string>> {
    if (packageName && !SAFE_PACKAGE.test(packageName)) {
      throw new Error(`Invalid package: ${packageName}`);
    }
    const commands: Record<string, string[]> = {
      cpuinfo: ["shell", "dumpsys", "cpuinfo"],
      power: ["shell", "dumpsys", "power"],
      battery: ["shell", "dumpsys", "battery"],
    };
    if (packageName) {
      commands.meminfo = ["shell", "dumpsys", "meminfo", packageName];
      commands.gfxinfo = [
        "shell",
        "dumpsys",
        "gfxinfo",
        packageName,
        "framestats",
      ];
    }
    const entries = await Promise.all(
      Object.entries(commands).map(async ([name, args]) => [
        name,
        await this.adb.text(args, {
          serial,
          signal,
          timeoutMs: 30_000,
          maxOutputBytes: 4 * 1024 * 1024,
        }),
      ]),
    );
    return Object.fromEntries(entries);
  }

  async recordDisplay(
    serial: string,
    physicalDisplayId: string,
    durationSeconds: number,
    signal?: AbortSignal,
  ): Promise<{ path: string; artifactUri: string; sizeBytes: number }> {
    if (!/^\d+$/.test(physicalDisplayId))
      throw new Error("Invalid physical display ID");
    await mkdir(this.artifactRoot, { recursive: true });
    const name = `recording-${Date.now()}-${physicalDisplayId}-${randomUUID()}.mp4`;
    const remotePath = `/data/local/tmp/${name}`;
    const destination = join(this.artifactRoot, name);
    try {
      await this.#queue.mutate(serial, () =>
        this.adb.run(
          [
            "shell",
            "screenrecord",
            "--display-id",
            physicalDisplayId,
            "--time-limit",
            String(durationSeconds),
            remotePath,
          ],
          {
            serial,
            signal,
            timeoutMs: (durationSeconds + 30) * 1_000,
            maxOutputBytes: 1024 * 1024,
          },
        ),
      );
      await this.adb.run(["pull", remotePath, destination], {
        serial,
        signal,
        timeoutMs: 120_000,
      });
      const details = await stat(destination);
      return {
        path: destination,
        artifactUri: `mobile://artifacts/${encodeURIComponent(name)}`,
        sizeBytes: details.size,
      };
    } finally {
      await this.adb
        .run(["shell", "rm", "-f", remotePath], { serial, timeoutMs: 10_000 })
        .catch(() => undefined);
    }
  }

  async permission(
    serial: string,
    input: {
      action: "grant" | "revoke";
      packageName: string;
      permission: string;
      userId: number;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    if (!SAFE_PACKAGE.test(input.packageName))
      throw new Error("Invalid package name");
    if (!SAFE_PERMISSION.test(input.permission))
      throw new Error("Invalid permission name");
    await this.#queue.mutate(serial, () =>
      this.adb.run(
        [
          "shell",
          "pm",
          input.action,
          "--user",
          String(input.userId),
          input.packageName,
          input.permission,
        ],
        { serial, signal },
      ),
    );
  }

  async listDefaultApps(
    serial: string,
    options: {
      userId: number;
      roles?: string[] | undefined;
      includeEmpty?: boolean | undefined;
      includeAllSystem?: boolean | undefined;
    },
    signal?: AbortSignal,
  ): Promise<{ userId: number; roles: RoleHolders[]; raw: string }> {
    // dumpsys role is device-wide; user_states may include multiple users.
    const raw = await this.adb.text(["shell", "dumpsys", "role"], {
      serial,
      signal,
      timeoutMs: 20_000,
      maxOutputBytes: 2 * 1024 * 1024,
    });
    const parsed = parseRoleDumpsys(raw, options.userId);
    const roles = filterRoles(parsed, {
      roles: options.roles,
      includeEmpty: options.includeEmpty,
      includeAllSystem: options.includeAllSystem,
    });
    return {
      userId: options.userId,
      roles,
      raw: raw.slice(0, 100_000),
    };
  }

  async getDefaultApp(
    serial: string,
    input: { userId: number; role: string },
    signal?: AbortSignal,
  ): Promise<RoleHolders & { userId: number }> {
    const role = resolveRoleName(input.role);
    const listed = await this.listDefaultApps(
      serial,
      {
        userId: input.userId,
        roles: [role],
        includeEmpty: true,
        includeAllSystem: true,
      },
      signal,
    );
    const entry = listed.roles.find((item) => item.role === role) ?? {
      role,
      holders: [],
    };
    return { userId: input.userId, ...entry };
  }

  async setDefaultApp(
    serial: string,
    input: {
      userId: number;
      role: string;
      packageName: string;
      exclusive?: boolean | undefined;
      bypassQualification?: boolean | undefined;
      /** HOME only: also call `cmd package set-home-activity` with this component. */
      homeComponent?: string | undefined;
    },
    signal?: AbortSignal,
  ): Promise<{
    userId: number;
    role: string;
    packageName: string;
    holders: string[];
    outputs: string[];
  }> {
    const role = resolveRoleName(input.role);
    const packageName = assertSafePackage(input.packageName);
    const exclusive = input.exclusive !== false;
    const homeComponent = input.homeComponent
      ? assertSafeComponent(input.homeComponent)
      : undefined;
    if (homeComponent && role !== "android.app.role.HOME") {
      throw new Error("homeComponent is only valid for the home role");
    }
    const outputs: string[] = [];

    await this.#queue.mutate(serial, async () => {
      if (input.bypassQualification) {
        outputs.push(
          await this.adb.text(
            [
              "shell",
              "cmd",
              "role",
              "set-bypassing-role-qualification",
              "true",
            ],
            { serial, signal },
          ),
        );
      }
      try {
        if (exclusive) {
          outputs.push(
            await this.adb.text(
              [
                "shell",
                "cmd",
                "role",
                "clear-role-holders",
                "--user",
                String(input.userId),
                role,
              ],
              { serial, signal },
            ),
          );
        }
        outputs.push(
          await this.adb.text(
            [
              "shell",
              "cmd",
              "role",
              "add-role-holder",
              "--user",
              String(input.userId),
              role,
              packageName,
            ],
            { serial, signal },
          ),
        );
        if (homeComponent) {
          outputs.push(
            await this.adb.text(
              [
                "shell",
                "cmd",
                "package",
                "set-home-activity",
                "--user",
                String(input.userId),
                homeComponent,
              ],
              { serial, signal },
            ),
          );
        }
      } finally {
        if (input.bypassQualification) {
          outputs.push(
            await this.adb
              .text(
                [
                  "shell",
                  "cmd",
                  "role",
                  "set-bypassing-role-qualification",
                  "false",
                ],
                { serial, signal },
              )
              .catch((error: unknown) =>
                error instanceof Error ? error.message : String(error),
              ),
          );
        }
      }
    });

    const after = await this.getDefaultApp(
      serial,
      { userId: input.userId, role },
      signal,
    );
    return {
      userId: input.userId,
      role,
      packageName,
      holders: after.holders,
      outputs: outputs.map((line) => line.trim()).filter(Boolean),
    };
  }

  async clearDefaultApp(
    serial: string,
    input: {
      userId: number;
      role: string;
      /** When set, remove only this package; otherwise clear all holders. */
      packageName?: string | undefined;
    },
    signal?: AbortSignal,
  ): Promise<{
    userId: number;
    role: string;
    holders: string[];
    output: string;
  }> {
    const role = resolveRoleName(input.role);
    const output = await this.#queue.mutate(serial, async () => {
      if (input.packageName) {
        const packageName = assertSafePackage(input.packageName);
        return await this.adb.text(
          [
            "shell",
            "cmd",
            "role",
            "remove-role-holder",
            "--user",
            String(input.userId),
            role,
            packageName,
          ],
          { serial, signal },
        );
      }
      return await this.adb.text(
        [
          "shell",
          "cmd",
          "role",
          "clear-role-holders",
          "--user",
          String(input.userId),
          role,
        ],
        { serial, signal },
      );
    });
    const after = await this.getDefaultApp(
      serial,
      { userId: input.userId, role },
      signal,
    );
    return {
      userId: input.userId,
      role,
      holders: after.holders,
      output: output.trim(),
    };
  }

  async listNotifications(
    serial: string,
    options: {
      packageName?: string | undefined;
      includeDetails?: boolean | undefined;
      maxDetails?: number | undefined;
    } = {},
    signal?: AbortSignal,
  ): Promise<{
    notifications: Array<NotificationRef | NotificationDetails>;
    count: number;
  }> {
    if (options.packageName) {
      assertSafeNotificationPackage(options.packageName);
    }
    const raw = await this.adb.text(["shell", "cmd", "notification", "list"], {
      serial,
      signal,
      timeoutMs: 15_000,
    });
    let notifications: Array<NotificationRef | NotificationDetails> =
      parseNotificationList(raw);
    if (options.packageName) {
      notifications = notifications.filter(
        (item) => item.packageName === options.packageName,
      );
    }
    if (options.includeDetails) {
      const limit = Math.min(Math.max(options.maxDetails ?? 40, 1), 80);
      const detailed: NotificationDetails[] = [];
      for (const item of notifications.slice(0, limit)) {
        detailed.push(await this.getNotification(serial, item.key, signal));
      }
      notifications = detailed;
    }
    return { notifications, count: notifications.length };
  }

  async getNotification(
    serial: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<NotificationDetails> {
    const safeKey = assertSafeNotificationKey(key);
    const raw = await this.adb.text(
      ["shell", "cmd", "notification", "get", quoteRemoteShellArg(safeKey)],
      { serial, signal, timeoutMs: 15_000, maxOutputBytes: 1 * 1024 * 1024 },
    );
    return parseNotificationRecord(raw);
  }

  async postNotification(
    serial: string,
    input: {
      tag: string;
      text: string;
      title?: string | undefined;
      verbose?: boolean | undefined;
    },
    signal?: AbortSignal,
  ): Promise<{
    tag: string;
    text: string;
    title?: string;
    key?: string;
    output: string;
    notification?: NotificationDetails;
  }> {
    const tag = assertSafeNotificationTag(input.tag);
    const text = assertSafeNotificationText(input.text, "text");
    const title = input.title
      ? assertSafeNotificationText(input.title, "title", 500)
      : undefined;
    const args = ["shell", "cmd", "notification", "post"];
    if (input.verbose) args.push("-v");
    if (title !== undefined) {
      args.push("-t", quoteRemoteShellArg(title));
    }
    args.push(tag, quoteRemoteShellArg(text));

    const output = await this.#queue.mutate(serial, () =>
      this.adb.text(args, { serial, signal, timeoutMs: 15_000 }),
    );

    // Shell posts as com.android.shell; StatusBar can lag briefly after post.
    let match: NotificationRef | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await abortableDelay(150 * attempt, signal);
      const listed = await this.listNotifications(
        serial,
        { packageName: "com.android.shell" },
        signal,
      );
      match = listed.notifications.find((item) => item.tag === tag);
      if (match) break;
    }
    const notification = match
      ? await this.getNotification(serial, match.key, signal).catch(
          () => undefined,
        )
      : undefined;

    return {
      tag,
      text,
      ...(title !== undefined ? { title } : {}),
      ...(match ? { key: match.key } : {}),
      output: output.trim(),
      ...(notification ? { notification } : {}),
    };
  }

  async push(
    serial: string,
    localPath: string,
    remotePath: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const safeLocal = await this.requireHostPath(localPath);
    this.requireRemotePath(remotePath);
    return await this.#queue.mutate(serial, () =>
      this.adb.text(["push", safeLocal, remotePath], {
        serial,
        signal,
        timeoutMs: 120_000,
      }),
    );
  }

  async pull(
    serial: string,
    remotePath: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; artifactUri: string; output: string }> {
    this.requireRemotePath(remotePath);
    try {
      await this.adb.run(
        ["shell", "test", "-f", quoteRemoteShellArg(remotePath)],
        { serial, signal },
      );
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw new Error(`Remote path is not a regular file: ${remotePath}`);
    }
    await mkdir(this.artifactRoot, { recursive: true });
    const name = `${Date.now()}-${randomUUID()}-${basename(remotePath).replaceAll(/[^A-Za-z0-9._-]/g, "_") || "artifact"}`;
    const destination = join(this.artifactRoot, name);
    const output = await this.#queue.mutate(serial, () =>
      this.adb.text(["pull", remotePath, destination], {
        serial,
        signal,
        timeoutMs: 120_000,
      }),
    );
    return {
      path: destination,
      artifactUri: `mobile://artifacts/${encodeURIComponent(name)}`,
      output,
    };
  }

  private async requireHostPath(path: string): Promise<string> {
    const absolute = isAbsolute(path)
      ? resolve(path)
      : resolve(this.hostRoot, path);
    const canonical = await realpath(absolute);
    const relation = relative(this.hostRoot, canonical);
    if (relation.startsWith("..") || isAbsolute(relation)) {
      throw new Error(`Host path must remain under ${this.hostRoot}`);
    }
    return canonical;
  }

  private requireRemotePath(path: string): void {
    if (
      path.includes("\0") ||
      path.split("/").includes("..") ||
      !SAFE_REMOTE_ROOTS.some((root) => path.startsWith(root))
    ) {
      throw new Error(
        `Remote path must remain under: ${SAFE_REMOTE_ROOTS.join(", ")}`,
      );
    }
  }
}
