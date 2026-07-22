import { AdbRunner, quoteRemoteShellArg } from "./adb-runner.js";

const SAFE_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
const SAFE_PREF_FILE = /^[A-Za-z0-9_./-]{1,128}$/;

export interface ActivityTop {
  displayId?: number;
  packageName?: string;
  activity?: string;
  taskId?: number;
  kind?: string;
  line: string;
}

export function parseActivityTops(raw: string): ActivityTop[] {
  const tops: ActivityTop[] = [];
  let sectionDisplayId: number | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const section =
      line.match(/^\s*Display\s+#(\d+)\b/i)?.[1] ??
      line.match(/^\s*Display:\s+mDisplayId=(\d+)/)?.[1] ??
      line.match(/DisplayContent\{.*?\s(\d+)\b/)?.[1];
    if (section !== undefined) {
      sectionDisplayId = Number(section);
      continue;
    }
    // Top-level dumpsys headers leave the previous Display #N section.
    if (line.trim() && !/^\s/.test(line)) {
      sectionDisplayId = undefined;
    }
    if (
      !/mResumedActivity|topResumedActivity|mFocusedApp|ResumedActivity/i.test(
        line,
      )
    ) {
      continue;
    }
    const trimmed = line.trim();
    const inlineDisplayId = Number(
      trimmed.match(/displayId[=:]?\s*(\d+)/i)?.[1] ??
        trimmed.match(/\bdisplay\s+(\d+)\b/i)?.[1],
    );
    const displayId = Number.isInteger(inlineDisplayId)
      ? inlineDisplayId
      : sectionDisplayId;
    const component =
      trimmed.match(
        /ActivityRecord\{[^}]*\s([A-Za-z0-9_.$]+\/[A-Za-z0-9_.$]+)/,
      )?.[1] ?? trimmed.match(/\b([A-Za-z0-9_.$]+\/[A-Za-z0-9_.$]+)\b/)?.[1];
    const taskId = Number(
      trimmed.match(/\bt(\d+)\b/)?.[1] ??
        trimmed.match(/taskId[=:]?\s*(\d+)/i)?.[1],
    );
    const kind = trimmed.match(
      /(topResumedActivity|mResumedActivity|mFocusedApp|ResumedActivity)/i,
    )?.[1];
    tops.push({
      line: trimmed,
      ...(displayId !== undefined && Number.isInteger(displayId)
        ? { displayId }
        : {}),
      ...(component
        ? {
            activity: component,
            packageName: component.split("/")[0],
          }
        : {}),
      ...(Number.isInteger(taskId) ? { taskId } : {}),
      ...(kind ? { kind } : {}),
    });
    if (tops.length >= 80) break;
  }
  return tops;
}

export class SystemOps {
  constructor(readonly adb = new AdbRunner()) {}

  async wake(serial: string, signal?: AbortSignal): Promise<string> {
    return await this.adb.text(
      ["shell", "input", "keyevent", "KEYCODE_WAKEUP"],
      { serial, signal },
    );
  }

  async getNightMode(
    serial: string,
    signal?: AbortSignal,
  ): Promise<{ raw: string; nightMode?: string }> {
    const raw = await this.adb.text(["shell", "cmd", "uimode", "night"], {
      serial,
      signal,
    });
    const nightMode = raw.match(/Night mode:\s*(\S+)/i)?.[1] ?? raw.trim();
    return { raw, ...(nightMode ? { nightMode } : {}) };
  }

  async setNightMode(
    serial: string,
    mode: "yes" | "no" | "auto" | "custom_schedule" | "custom_bedtime",
    signal?: AbortSignal,
  ): Promise<string> {
    return await this.adb.text(["shell", "cmd", "uimode", "night", mode], {
      serial,
      signal,
    });
  }

  async activityTops(
    serial: string,
    signal?: AbortSignal,
  ): Promise<{
    raw: string;
    tops: ActivityTop[];
    byDisplayId: Record<string, ActivityTop[]>;
  }> {
    const raw = await this.adb.text(
      ["shell", "dumpsys", "activity", "activities"],
      { serial, signal, timeoutMs: 20_000, maxOutputBytes: 4 * 1024 * 1024 },
    );
    const tops = parseActivityTops(raw);
    const byDisplayId: Record<string, ActivityTop[]> = {};
    for (const top of tops) {
      if (top.displayId === undefined) continue;
      const key = String(top.displayId);
      (byDisplayId[key] ??= []).push(top);
    }
    return { raw: raw.slice(0, 200_000), tops, byDisplayId };
  }

  async layerHints(
    serial: string,
    signal?: AbortSignal,
  ): Promise<{ raw: string; hints: string[] }> {
    const raw = await this.adb.text(["shell", "dumpsys", "SurfaceFlinger"], {
      serial,
      signal,
      timeoutMs: 20_000,
      maxOutputBytes: 2 * 1024 * 1024,
    });
    const hints: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (
        /Presentation|HWC|Layer|display|Black|Foreign/i.test(line) &&
        line.trim().length > 0
      ) {
        hints.push(line.trim());
        if (hints.length >= 120) break;
      }
    }
    return { raw: raw.slice(0, 100_000), hints };
  }

  async readSharedPrefs(
    serial: string,
    packageName: string,
    fileName: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!SAFE_PACKAGE.test(packageName))
      throw new Error(`Invalid package: ${packageName}`);
    if (!SAFE_PREF_FILE.test(fileName) || fileName.includes("..")) {
      throw new Error(`Invalid shared_prefs file: ${fileName}`);
    }
    const remote = `shared_prefs/${fileName}`;
    return await this.adb.text(
      ["shell", "run-as", packageName, "cat", quoteRemoteShellArg(remote)],
      { serial, signal, timeoutMs: 15_000, maxOutputBytes: 1 * 1024 * 1024 },
    );
  }
}
