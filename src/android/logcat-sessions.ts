import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { finished } from "node:stream/promises";

import { AdbRunner } from "./adb-runner.js";

const SAFE_TAG = /^[A-Za-z0-9_./-]{1,128}$/;
const SAFE_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;

export interface LogcatFilters {
  tags?: string[] | undefined;
  packages?: string[] | undefined;
  buffer?: "main" | "system" | "crash" | "events" | "radio" | undefined;
  minimumPriority?: "V" | "D" | "I" | "W" | "E" | "F" | undefined;
}

export interface ActiveLogcatSession {
  logSessionId: string;
  serial: string;
  localName: string;
  pathHint: string;
  startedAtMs: number;
  filters: LogcatFilters;
  process: ChildProcess;
  boundRecordId?: string | undefined;
}

export interface StoppedLogcatSession {
  logSessionId: string;
  serial: string;
  path: string;
  artifactUri: string;
  sizeBytes: number;
  durationMs: number;
  lines: string[];
  lineCount: number;
  truncated: boolean;
  boundRecordId?: string | undefined;
}

export class LogcatSessionManager {
  readonly #sessions = new Map<string, ActiveLogcatSession>();

  constructor(
    readonly adb = new AdbRunner(),
    readonly artifactRoot: string,
  ) {}

  get(logSessionId: string): ActiveLogcatSession | undefined {
    return this.#sessions.get(logSessionId);
  }

  async start(
    serial: string,
    filters: LogcatFilters = {},
    options: { boundRecordId?: string | undefined } = {},
  ): Promise<{ logSessionId: string; pathHint: string }> {
    const tags = filters.tags ?? [];
    const packages = filters.packages ?? [];
    for (const tag of tags) {
      if (!SAFE_TAG.test(tag)) throw new Error(`Invalid logcat tag: ${tag}`);
    }
    for (const packageName of packages) {
      if (!SAFE_PACKAGE.test(packageName)) {
        throw new Error(`Invalid package filter: ${packageName}`);
      }
    }

    await mkdir(this.artifactRoot, { recursive: true });
    const logSessionId = randomUUID();
    const localName = `logcat-${Date.now()}-${logSessionId}.log`;
    const pathHint = join(this.artifactRoot, localName);
    const buffer = filters.buffer ?? "main";
    const minimumPriority = filters.minimumPriority ?? "I";

    const args = [
      "-s",
      serial,
      "shell",
      "logcat",
      "-v",
      "threadtime",
      "-b",
      buffer,
    ];
    if (tags.length > 0) {
      args.push(...tags.map((tag) => `${tag}:${minimumPriority}`), "*:S");
    } else {
      args.push(`*:${minimumPriority}`);
    }

    // Clear only the selected buffer so the session starts at "now".
    await this.adb
      .run(["shell", "logcat", "-b", buffer, "-c"], {
        serial,
        timeoutMs: 10_000,
      })
      .catch(() => undefined);

    const child = spawn(this.adb.executable, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (!child.stdout) {
      child.kill("SIGKILL");
      throw new Error("Failed to open logcat stdout pipe");
    }
    const out = createWriteStream(pathHint, { flags: "wx" });
    child.stdout.pipe(out);
    child.stderr?.on("data", () => undefined);
    child.on("error", () => undefined);

    this.#sessions.set(logSessionId, {
      logSessionId,
      serial,
      localName,
      pathHint,
      startedAtMs: Date.now(),
      filters: { tags, packages, buffer, minimumPriority },
      process: child,
      ...(options.boundRecordId
        ? { boundRecordId: options.boundRecordId }
        : {}),
    });

    return { logSessionId, pathHint };
  }

  async stop(
    serial: string,
    logSessionId: string,
    options: { maxLines?: number | undefined } = {},
  ): Promise<StoppedLogcatSession> {
    const session = this.#sessions.get(logSessionId);
    if (!session || session.serial !== serial) {
      throw new Error(`Unknown logcat session ${logSessionId} on ${serial}`);
    }

    const durationMs = Math.max(0, Date.now() - session.startedAtMs);
    try {
      if (!session.process.killed) {
        session.process.kill("SIGINT");
      }
      await Promise.race([
        new Promise<void>((resolve) =>
          session.process.once("exit", () => resolve()),
        ),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (!session.process.killed && session.process.exitCode === null) {
        session.process.kill("SIGKILL");
      }
      if (session.process.stdout) {
        await finished(session.process.stdout).catch(() => undefined);
      }

      const maxLines = options.maxLines ?? 2_000;
      let text = await readFile(session.pathHint, "utf8");
      if ((session.filters.packages ?? []).length > 0) {
        const packages = new Set(session.filters.packages);
        text = text
          .split(/\r?\n/)
          .filter((line) => {
            if (!line.trim()) return false;
            for (const packageName of packages) {
              if (line.includes(packageName)) return true;
            }
            return false;
          })
          .join("\n");
      }
      const allLines = text.split(/\r?\n/).filter((line) => line.length > 0);
      const truncated = allLines.length > maxLines;
      const lines = truncated ? allLines.slice(-maxLines) : allLines;
      const details = await stat(session.pathHint);

      return {
        logSessionId,
        serial,
        path: session.pathHint,
        artifactUri: `mobile://artifacts/${encodeURIComponent(session.localName)}`,
        sizeBytes: details.size,
        durationMs,
        lines,
        lineCount: allLines.length,
        truncated,
        ...(session.boundRecordId
          ? { boundRecordId: session.boundRecordId }
          : {}),
      };
    } finally {
      this.#sessions.delete(logSessionId);
    }
  }

  async stopAll(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    await Promise.allSettled(
      sessions.map((session) =>
        this.stop(session.serial, session.logSessionId),
      ),
    );
  }
}
