import { randomUUID } from "node:crypto";

import {
  AdbCommandError,
  AdbRunner,
  quoteRemoteShellArg,
} from "./adb-runner.js";
import { DeviceQueue } from "./device-queue.js";
import {
  correlatePhysicalDisplays,
  parseDevices,
  parseInputCapabilities,
  parseLogicalDisplays,
  parsePhysicalDisplays,
  parseProperties,
} from "./parsers.js";
import type {
  AndroidDevice,
  AndroidDisplay,
  DeviceCapabilities,
  OperationEnvelope,
} from "./types.js";

const SAFE_SERIAL = /^[A-Za-z0-9._:[\]-]+$/;
const SAFE_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
const SAFE_COMPONENT = /^[A-Za-z0-9_.$]+\/[A-Za-z0-9_.$]+$/;
const SAFE_KEY = /^(?:KEYCODE_)?[A-Z0-9_]+$|^\d{1,4}$/;

export interface KeyInput {
  key: string;
  displayId: number;
  source?: "keyboard" | "dpad" | "gamepad" | undefined;
  action?: "press" | "long_press" | "double_tap" | undefined;
  durationMs?: number | undefined;
}

export class AndroidController {
  readonly #queue = new DeviceQueue();
  readonly #capabilities = new Map<
    string,
    { value: DeviceCapabilities; cachedAt: number; transportId?: string }
  >();

  constructor(readonly adb = new AdbRunner()) {}

  async listDevices(signal?: AbortSignal): Promise<AndroidDevice[]> {
    return parseDevices(await this.adb.text(["devices", "-l"], { signal }));
  }

  async requireDevice(
    serial: string,
    signal?: AbortSignal,
  ): Promise<AndroidDevice> {
    if (!SAFE_SERIAL.test(serial))
      throw new Error(`Invalid device serial: ${serial}`);
    const device = (await this.listDevices(signal)).find(
      (candidate) => candidate.serial === serial,
    );
    if (!device) throw new Error(`Device is not connected: ${serial}`);
    if (device.state !== "device")
      throw new Error(`Device ${serial} is ${device.state}`);
    return device;
  }

  async inspectDevice(
    serial: string,
    options: {
      refresh?: boolean | undefined;
      signal?: AbortSignal | undefined;
    } = {},
  ): Promise<DeviceCapabilities> {
    const device = await this.requireDevice(serial, options.signal);
    if (!options.refresh) {
      const cached = this.#capabilities.get(serial);
      if (
        cached &&
        Date.now() - cached.cachedAt < 60_000 &&
        cached.transportId === device.transportId
      ) {
        return cached.value;
      }
    }

    const [adbVersion, propertiesText, featuresText, inputHelp] =
      await Promise.all([
        this.adb.text(["version"], { signal: options.signal }),
        this.adb.text(["shell", "getprop"], { serial, signal: options.signal }),
        this.adb.text(["features"], { serial, signal: options.signal }),
        this.probe(serial, ["shell", "input"], options.signal),
      ]);
    const properties = parseProperties(propertiesText);
    const commandNames = [
      "screencap",
      "screenrecord",
      "uiautomator",
      "getevent",
      "sendevent",
      "uinput",
      "logcat",
      "perfetto",
      "simpleperf",
    ];
    const commands = Object.fromEntries(
      await Promise.all(
        commandNames.map(async (command) => {
          const result = await this.probe(
            serial,
            ["shell", "command", "-v", command],
            options.signal,
          );
          return [
            command,
            result.supported && result.output.length > 0,
          ] as const;
        }),
      ),
    );
    const capabilities: DeviceCapabilities = {
      serial,
      adbVersion: adbVersion.split(/\r?\n/)[0] ?? adbVersion,
      apiLevel: Number(properties["ro.build.version.sdk"] ?? 0),
      release: properties["ro.build.version.release"] ?? "unknown",
      manufacturer: properties["ro.product.manufacturer"] ?? "unknown",
      model: properties["ro.product.model"] ?? "unknown",
      buildType: properties["ro.build.type"] ?? "unknown",
      features: featuresText.split(/\s+/).filter(Boolean),
      input: parseInputCapabilities(
        inputHelp.supported ? inputHelp.output : "",
      ),
      commands,
      probedAt: new Date().toISOString(),
    };
    this.#capabilities.set(serial, {
      value: capabilities,
      cachedAt: Date.now(),
      ...(device.transportId ? { transportId: device.transportId } : {}),
    });
    return capabilities;
  }

  async listDisplays(
    serial: string,
    signal?: AbortSignal,
  ): Promise<AndroidDisplay[]> {
    await this.requireDevice(serial, signal);
    const [displayDump, physicalDump, windowDump] = await Promise.all([
      this.adb.text(["shell", "dumpsys", "display"], {
        serial,
        signal,
        timeoutMs: 15_000,
      }),
      this.probe(
        serial,
        ["shell", "dumpsys", "SurfaceFlinger", "--display-id"],
        signal,
      ),
      this.probe(serial, ["shell", "dumpsys", "window", "displays"], signal),
    ]);
    const displays = correlatePhysicalDisplays(
      parseLogicalDisplays(displayDump),
      parsePhysicalDisplays(physicalDump.output),
    );
    this.attachWindowFocus(displays, windowDump.output);
    return displays;
  }

  async captureScreen(
    serial: string,
    displayId: number,
    signal?: AbortSignal,
  ): Promise<{ png: Buffer; display: AndroidDisplay; durationMs: number }> {
    const displays = await this.listDisplays(serial, signal);
    const display = displays.find(
      (candidate) => candidate.logicalId === displayId,
    );
    if (!display) {
      throw new Error(
        `Logical display ${displayId} is not available on ${serial}`,
      );
    }
    const physicalDisplays = displays.filter(
      (candidate) => candidate.physicalId !== undefined,
    );
    if (
      !display.physicalId &&
      (displayId !== 0 || physicalDisplays.length !== 1)
    ) {
      throw new Error(
        `Logical display ${displayId} has no correlated physical ID and cannot be captured by screencap`,
      );
    }
    const args = ["exec-out", "screencap", "-p"];
    if (display.physicalId) args.push("-d", display.physicalId);
    const result = await this.adb.run(args, {
      serial,
      signal,
      timeoutMs: 20_000,
      maxOutputBytes: 32 * 1024 * 1024,
    });
    if (!result.stdout.subarray(1, 4).equals(Buffer.from("PNG"))) {
      throw new Error("screencap did not return a PNG image");
    }
    return { png: result.stdout, display, durationMs: result.durationMs };
  }

  async uiSnapshot(
    serial: string,
    displayId: number,
    signal?: AbortSignal,
  ): Promise<string> {
    await this.requireDisplay(serial, displayId, signal);
    if (displayId !== 0) {
      throw new Error(
        "Portable uiautomator cannot select a non-default display; enable the instrumentation backend",
      );
    }
    const remotePath = `/data/local/tmp/polyscreen-${randomUUID()}.xml`;
    try {
      const dump = await this.adb.run(
        ["shell", "uiautomator", "dump", remotePath],
        {
          serial,
          signal,
          timeoutMs: 20_000,
        },
      );
      const output = await this.adb.text(["exec-out", "cat", remotePath], {
        serial,
        signal,
        timeoutMs: 20_000,
        maxOutputBytes: 16 * 1024 * 1024,
      });
      const start = output.indexOf("<?xml");
      if (start < 0) {
        const diagnostic = Buffer.concat([dump.stdout, dump.stderr])
          .toString("utf8")
          .trim();
        throw new Error(
          `UIAutomator did not produce an XML hierarchy${diagnostic ? `: ${diagnostic}` : ""}`,
        );
      }
      return output.slice(start);
    } finally {
      await this.adb
        .run(["shell", "rm", "-f", remotePath], { serial })
        .catch(() => undefined);
    }
  }

  async tap(
    serial: string,
    displayId: number,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<OperationEnvelope<{ x: number; y: number }>> {
    return await this.mutate(
      serial,
      displayId,
      ["touchscreen", "-d", String(displayId), "tap", String(x), String(y)],
      { x, y },
      signal,
    );
  }

  async swipe(
    serial: string,
    displayId: number,
    start: { x: number; y: number },
    end: { x: number; y: number },
    durationMs: number,
    signal?: AbortSignal,
  ): Promise<
    OperationEnvelope<{
      start: typeof start;
      end: typeof end;
      durationMs: number;
    }>
  > {
    return await this.mutate(
      serial,
      displayId,
      [
        "touchscreen",
        "-d",
        String(displayId),
        "swipe",
        String(start.x),
        String(start.y),
        String(end.x),
        String(end.y),
        String(durationMs),
      ],
      { start, end, durationMs },
      signal,
    );
  }

  async dragAndDrop(
    serial: string,
    displayId: number,
    start: { x: number; y: number },
    end: { x: number; y: number },
    durationMs: number,
    signal?: AbortSignal,
  ): Promise<
    OperationEnvelope<{
      start: typeof start;
      end: typeof end;
      durationMs: number;
    }>
  > {
    const capabilities = await this.inspectDevice(serial, { signal });
    if (!capabilities.input.commands.dragAndDrop) {
      throw new Error(
        "This device does not advertise ADB drag-and-drop support",
      );
    }
    return await this.mutate(
      serial,
      displayId,
      [
        "touchscreen",
        "-d",
        String(displayId),
        "draganddrop",
        String(start.x),
        String(start.y),
        String(end.x),
        String(end.y),
        String(durationMs),
      ],
      { start, end, durationMs },
      signal,
    );
  }

  async inputKeyCombination(
    serial: string,
    displayId: number,
    keys: string[],
    durationMs: number,
    source: "keyboard" | "dpad" | "gamepad",
    signal?: AbortSignal,
  ): Promise<
    OperationEnvelope<{
      keys: string[];
      durationMs: number;
      source: "keyboard" | "dpad" | "gamepad";
    }>
  > {
    const capabilities = await this.inspectDevice(serial, { signal });
    if (!capabilities.input.commands.keyCombination) {
      throw new Error(
        "This device does not advertise simultaneous key-combination support",
      );
    }
    for (const key of keys) {
      if (!SAFE_KEY.test(key))
        throw new Error(`Invalid Android keycode: ${key}`);
    }
    return await this.mutate(
      serial,
      displayId,
      [
        source,
        "-d",
        String(displayId),
        "keycombination",
        "-t",
        String(durationMs),
        ...keys,
      ],
      { keys, durationMs, source },
      signal,
    );
  }

  async inputKey(
    serial: string,
    input: KeyInput,
    signal?: AbortSignal,
  ): Promise<OperationEnvelope<KeyInput>> {
    if (!SAFE_KEY.test(input.key))
      throw new Error(`Invalid Android keycode: ${input.key}`);
    const capabilities = await this.inspectDevice(serial, { signal });
    const action = input.action ?? "press";
    const source = input.source ?? "gamepad";
    const args = [source, "-d", String(input.displayId), "keyevent"];
    if (action === "long_press") {
      if (
        input.durationMs !== undefined &&
        capabilities.input.keyOptions.duration
      ) {
        args.push("--duration", String(input.durationMs));
      } else if (capabilities.input.keyOptions.longPress) {
        args.push("--longpress");
      } else {
        throw new Error(
          "This device does not advertise key long-press support",
        );
      }
    } else if (action === "double_tap") {
      if (!capabilities.input.keyOptions.doubleTap) {
        throw new Error(
          "This device does not advertise key double-tap support",
        );
      }
      args.push("--doubletap");
    }
    args.push(input.key);
    return await this.mutate(serial, input.displayId, args, input, signal);
  }

  async inputText(
    serial: string,
    displayId: number,
    text: string,
    signal?: AbortSignal,
  ): Promise<OperationEnvelope<{ text: string; unicodeReliable: false }>> {
    const encoded = text.replaceAll(" ", "%s");
    return await this.mutate(
      serial,
      displayId,
      [
        "keyboard",
        "-d",
        String(displayId),
        "text",
        quoteRemoteShellArg(encoded),
      ],
      { text, unicodeReliable: false },
      signal,
      [
        "ADB input text is not reliable for arbitrary Unicode; use the scrcpy backend when enabled",
      ],
    );
  }

  async inspectApp(
    serial: string,
    packageName: string,
    signal?: AbortSignal,
  ): Promise<string> {
    this.validatePackage(packageName);
    return await this.adb.text(["shell", "dumpsys", "package", packageName], {
      serial,
      signal,
      timeoutMs: 20_000,
      maxOutputBytes: 16 * 1024 * 1024,
    });
  }

  async launchApp(
    serial: string,
    packageName: string,
    displayId: number,
    activity?: string,
    signal?: AbortSignal,
  ): Promise<
    OperationEnvelope<{
      packageName: string;
      component: string;
      requestedDisplayId: number;
      observedFocusedDisplayId?: number;
      output: string;
    }>
  > {
    this.validatePackage(packageName);
    await this.requireDisplay(serial, displayId, signal);
    const component = activity
      ? this.normalizeComponent(packageName, activity)
      : await this.resolveMainActivity(serial, packageName, signal);
    const result = await this.#queue.mutate(serial, () =>
      this.adb.run(
        [
          "shell",
          "am",
          "start",
          "-W",
          "--display",
          String(displayId),
          "-n",
          component,
        ],
        { serial, signal, timeoutMs: 30_000 },
      ),
    );
    const observedDisplay = (await this.listDisplays(serial, signal)).find(
      (display) =>
        display.focusedActivity?.startsWith(`${packageName}/`) ||
        display.focusedWindow?.startsWith(`${packageName}/`),
    );
    const warnings =
      observedDisplay?.logicalId === displayId
        ? []
        : [
            observedDisplay
              ? `Activity was requested on display ${displayId} but focus was observed on display ${observedDisplay.logicalId}`
              : "Launch succeeded but the package was not observed as focused on any display",
          ];
    return this.envelope(
      serial,
      displayId,
      "adb",
      {
        packageName,
        component,
        requestedDisplayId: displayId,
        ...(observedDisplay
          ? { observedFocusedDisplayId: observedDisplay.logicalId }
          : {}),
        output: result.stdout.toString("utf8").trim(),
      },
      result.durationMs,
      warnings,
    );
  }

  async stopApp(
    serial: string,
    packageName: string,
    userId: number | "current",
    signal?: AbortSignal,
  ): Promise<
    OperationEnvelope<{ packageName: string; userId: number | "current" }>
  > {
    this.validatePackage(packageName);
    const result = await this.#queue.mutate(serial, () =>
      this.adb.run(
        ["shell", "am", "force-stop", "--user", String(userId), packageName],
        {
          serial,
          signal,
        },
      ),
    );
    return this.envelope(
      serial,
      undefined,
      "adb",
      { packageName, userId },
      result.durationMs,
    );
  }

  async installApp(
    serial: string,
    apkPath: string,
    replace: boolean,
    signal?: AbortSignal,
  ): Promise<OperationEnvelope<{ path: string; output: string }>> {
    if (!apkPath.endsWith(".apk"))
      throw new Error("Only .apk installation is supported by this tool");
    const args = ["install"];
    if (replace) args.push("-r");
    args.push(apkPath);
    const result = await this.#queue.mutate(serial, () =>
      this.adb.run(args, {
        serial,
        signal,
        timeoutMs: 180_000,
        maxOutputBytes: 2 * 1024 * 1024,
      }),
    );
    return this.envelope(
      serial,
      undefined,
      "adb",
      { path: apkPath, output: result.stdout.toString("utf8").trim() },
      result.durationMs,
    );
  }

  async uninstallApp(
    serial: string,
    packageName: string,
    keepData: boolean,
    signal?: AbortSignal,
  ): Promise<
    OperationEnvelope<{
      packageName: string;
      keepData: boolean;
      output: string;
    }>
  > {
    this.validatePackage(packageName);
    const args = ["uninstall"];
    if (keepData) args.push("-k");
    args.push(packageName);
    const result = await this.#queue.mutate(serial, () =>
      this.adb.run(args, { serial, signal, timeoutMs: 60_000 }),
    );
    return this.envelope(
      serial,
      undefined,
      "adb",
      { packageName, keepData, output: result.stdout.toString("utf8").trim() },
      result.durationMs,
    );
  }

  async collectDiagnostics(
    serial: string,
    sections: readonly (
      | "activity"
      | "window"
      | "display"
      | "input"
      | "power"
      | "battery"
      | "meminfo"
      | "cpuinfo"
    )[],
    packageName?: string,
    signal?: AbortSignal,
  ): Promise<Record<string, string>> {
    if (packageName) this.validatePackage(packageName);
    const result: Record<string, string> = {};
    for (const section of sections) {
      const args =
        section === "activity"
          ? ["shell", "dumpsys", "activity", "activities"]
          : section === "window"
            ? ["shell", "dumpsys", "window", "displays"]
            : section === "meminfo" && packageName
              ? ["shell", "dumpsys", "meminfo", packageName]
              : ["shell", "dumpsys", section];
      result[section] = await this.adb.text(args, {
        serial,
        signal,
        maxOutputBytes: 4 * 1024 * 1024,
        timeoutMs: 15_000,
      });
    }
    return result;
  }

  private async mutate<T>(
    serial: string,
    displayId: number,
    inputArgs: string[],
    data: T,
    signal?: AbortSignal,
    warnings: string[] = [],
  ): Promise<OperationEnvelope<T>> {
    await this.requireDisplay(serial, displayId, signal);
    const capabilities = await this.inspectDevice(serial, { signal });
    const source = inputArgs[0];
    const commandIndex = inputArgs.findIndex((value) =>
      [
        "text",
        "keyevent",
        "tap",
        "swipe",
        "draganddrop",
        "motionevent",
        "keycombination",
        "scroll",
      ].includes(value.toLowerCase()),
    );
    const command = inputArgs[commandIndex]?.toLowerCase();
    const commandKey = command === "draganddrop" ? "dragAndDrop" : command;
    const advertisedCommands = Object.values(capabilities.input.commands).some(
      Boolean,
    );
    if (
      commandKey &&
      advertisedCommands &&
      !capabilities.input.commands[
        commandKey as keyof typeof capabilities.input.commands
      ]
    ) {
      throw new Error(`Device input command is not supported: ${command}`);
    }
    if (
      source &&
      capabilities.input.sources.length > 0 &&
      !capabilities.input.sources.includes(source)
    ) {
      throw new Error(`Device input source is not supported: ${source}`);
    }
    if (!capabilities.input.displayTargeting) {
      if (displayId !== 0) {
        throw new Error(
          "This device input implementation cannot target non-default displays",
        );
      }
      const displayOption = inputArgs.indexOf("-d");
      if (displayOption >= 0) inputArgs.splice(displayOption, 2);
      warnings = [
        ...warnings,
        "Device input help does not advertise display targeting; used the default-display form",
      ];
    }
    const result = await this.#queue.mutate(serial, () =>
      this.adb.run(["shell", "input", ...inputArgs], { serial, signal }),
    );
    return this.envelope(
      serial,
      displayId,
      "adb",
      data,
      result.durationMs,
      warnings,
    );
  }

  private envelope<T>(
    serial: string,
    displayId: number | undefined,
    backend: "adb" | "scrcpy" | "instrumentation",
    data: T,
    durationMs: number,
    warnings: string[] = [],
  ): OperationEnvelope<T> {
    return {
      schemaVersion: "1",
      operationId: this.adb.operationId(),
      device: { serial },
      ...(displayId !== undefined ? { display: { logicalId: displayId } } : {}),
      backend,
      data,
      durationMs,
      warnings,
    };
  }

  private async requireDisplay(
    serial: string,
    displayId: number,
    signal?: AbortSignal,
  ): Promise<AndroidDisplay> {
    const display = (await this.listDisplays(serial, signal)).find(
      (candidate) => candidate.logicalId === displayId,
    );
    if (!display)
      throw new Error(
        `Logical display ${displayId} is not available on ${serial}`,
      );
    return display;
  }

  private attachWindowFocus(displays: AndroidDisplay[], output: string): void {
    let displayId: number | undefined;
    for (const line of output.split(/\r?\n/)) {
      const displayMatch =
        line.match(/^\s*Display:\s+mDisplayId=(\d+)/) ??
        line.match(/DisplayContent\{.*?\s(\d+)\b/);
      if (displayMatch?.[1]) displayId = Number(displayMatch[1]);
      if (displayId === undefined) continue;
      const display = displays.find(
        (candidate) => candidate.logicalId === displayId,
      );
      if (!display) continue;
      const focus = line.match(
        /mCurrentFocus=Window\{[^ ]+\s[^ ]+\s([^}]+)}/,
      )?.[1];
      const app = line.match(
        /mFocusedApp=.*?\s([A-Za-z0-9_.$]+\/[A-Za-z0-9_.$]+)/,
      )?.[1];
      if (focus) display.focusedWindow = focus;
      if (app) display.focusedActivity = app;
    }
  }

  private async resolveMainActivity(
    serial: string,
    packageName: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const output = await this.adb.text(
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
        packageName,
      ],
      { serial, signal },
    );
    const component = output
      .split(/\r?\n/)
      .find((line) => line.includes("/"))
      ?.trim();
    if (!component || !SAFE_COMPONENT.test(component)) {
      throw new Error(
        `Could not resolve a launcher activity for ${packageName}`,
      );
    }
    return component;
  }

  private normalizeComponent(packageName: string, activity: string): string {
    const normalizedActivity =
      activity.startsWith(".") || activity.includes(".")
        ? activity
        : `.${activity}`;
    const component = activity.includes("/")
      ? activity
      : `${packageName}/${normalizedActivity}`;
    if (!SAFE_COMPONENT.test(component))
      throw new Error(`Invalid activity component: ${component}`);
    return component;
  }

  private validatePackage(packageName: string): void {
    if (!SAFE_PACKAGE.test(packageName))
      throw new Error(`Invalid Android package: ${packageName}`);
  }

  private async probe(
    serial: string,
    args: readonly string[],
    signal?: AbortSignal,
    maxOutputBytes = 1_048_576,
  ): Promise<{ supported: boolean; output: string; exitCode: number }> {
    try {
      const result = await this.adb.run(args, {
        serial,
        signal,
        maxOutputBytes,
        timeoutMs: 15_000,
      });
      return {
        supported: true,
        output: Buffer.concat([result.stdout, result.stderr])
          .toString("utf8")
          .trim(),
        exitCode: result.exitCode,
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof AdbCommandError) {
        return {
          supported: false,
          output: Buffer.concat([error.result.stdout, error.result.stderr])
            .toString("utf8")
            .trim(),
          exitCode: error.result.exitCode,
        };
      }
      return { supported: false, output: "", exitCode: -1 };
    }
  }
}
