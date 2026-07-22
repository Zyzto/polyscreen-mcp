import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Transform } from "node:stream";
import { finished } from "node:stream/promises";

import { ArtifactStore } from "../artifacts/store.js";
import { AdbRunner } from "./adb-runner.js";

const SAFE_TAG = /^[A-Za-z0-9_./-]{1,128}$/;
const SAFE_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
/** threadtime: `01-01 00:00:00.000  1234  5678 I Tag: msg` */
const THREADTIME_PID =
  /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+(\d+)\s+(\d+)\s+\w\s+/;
const PID_REFRESH_MS = 1_000;

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
  out: WriteStream;
  packagePids?: Set<number> | undefined;
  pidRefresh?: ReturnType<typeof setInterval> | undefined;
  pidRefreshInFlight?: Promise<void> | undefined;
  boundRecordId?: string | undefined;
  boundRecordStartedAtMs?: number | undefined;
}

export interface StoppedLogcatSession {
  logSessionId: string;
  serial: string;
  path: string;
  artifactUri: string;
  sizeBytes: number;
  durationMs: number;
  startedAtIso: string;
  stoppedAtIso: string;
  lines: string[];
  lineCount: number;
  truncated: boolean;
  boundRecordId?: string | undefined;
  /** Host ISO when the bound recording started — join with session bounds, not per-line. */
  boundRecordStartedAtIso?: string | undefined;
}

export interface LogcatSessionStatus {
  logSessionId: string;
  serial: string;
  startedAtIso: string;
  elapsedMs: number;
  pathHint: string;
  tags: string[];
  packages: string[];
  buffer: string;
  minimumPriority: string;
  boundRecordId?: string | undefined;
}

export class LogcatSessionManager {
  readonly #sessions = new Map<string, ActiveLogcatSession>();
  readonly artifacts: ArtifactStore;

  constructor(
    readonly adb = new AdbRunner(),
    artifactsOrRoot: ArtifactStore | string,
  ) {
    this.artifacts =
      typeof artifactsOrRoot === "string"
        ? new ArtifactStore(artifactsOrRoot)
        : artifactsOrRoot;
  }

  get artifactRoot(): string {
    return this.artifacts.root;
  }

  get(logSessionId: string): ActiveLogcatSession | undefined {
    return this.#sessions.get(logSessionId);
  }

  listActive(serial?: string): LogcatSessionStatus[] {
    const now = Date.now();
    return [...this.#sessions.values()]
      .filter((session) => !serial || session.serial === serial)
      .map((session) => ({
        logSessionId: session.logSessionId,
        serial: session.serial,
        startedAtIso: new Date(session.startedAtMs).toISOString(),
        elapsedMs: Math.max(0, now - session.startedAtMs),
        pathHint: session.pathHint,
        tags: session.filters.tags ?? [],
        packages: session.filters.packages ?? [],
        buffer: session.filters.buffer ?? "main",
        minimumPriority: session.filters.minimumPriority ?? "I",
        ...(session.boundRecordId
          ? { boundRecordId: session.boundRecordId }
          : {}),
      }))
      .sort((a, b) => a.serial.localeCompare(b.serial));
  }

  async start(
    serial: string,
    filters: LogcatFilters = {},
    options: {
      boundRecordId?: string | undefined;
      boundRecordStartedAtMs?: number | undefined;
    } = {},
  ): Promise<{
    logSessionId: string;
    pathHint: string;
    startedAtIso: string;
    boundRecordId?: string | undefined;
    boundRecordStartedAtIso?: string | undefined;
  }> {
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
    const packageSet = packages.length > 0 ? new Set(packages) : undefined;
    const packagePids = packageSet ? new Set<number>() : undefined;
    if (packageSet && packagePids) {
      await refreshPackagePids(this.adb, serial, packageSet, packagePids);
      child.stdout
        .pipe(createPackageLineFilter(packageSet, () => packagePids))
        .pipe(out);
    } else {
      child.stdout.pipe(out);
    }
    child.stderr?.on("data", () => undefined);
    child.on("error", () => undefined);

    const startedAtMs = Date.now();
    const session: ActiveLogcatSession = {
      logSessionId,
      serial,
      localName,
      pathHint,
      startedAtMs,
      filters: { tags, packages, buffer, minimumPriority },
      process: child,
      out,
      ...(packagePids ? { packagePids } : {}),
      ...(options.boundRecordId
        ? { boundRecordId: options.boundRecordId }
        : {}),
      ...(options.boundRecordStartedAtMs !== undefined
        ? { boundRecordStartedAtMs: options.boundRecordStartedAtMs }
        : {}),
    };

    if (packageSet && packagePids) {
      session.pidRefresh = setInterval(() => {
        // Serialize refreshes so a slow pidof cannot overwrite a newer result.
        session.pidRefreshInFlight = (
          session.pidRefreshInFlight ?? Promise.resolve()
        )
          .catch(() => undefined)
          .then(() =>
            refreshPackagePids(this.adb, serial, packageSet, packagePids),
          );
      }, PID_REFRESH_MS);
      session.pidRefresh.unref?.();
    }

    this.#sessions.set(logSessionId, session);

    return {
      logSessionId,
      pathHint,
      startedAtIso: new Date(startedAtMs).toISOString(),
      ...(options.boundRecordId
        ? { boundRecordId: options.boundRecordId }
        : {}),
      ...(options.boundRecordStartedAtMs !== undefined
        ? {
            boundRecordStartedAtIso: new Date(
              options.boundRecordStartedAtMs,
            ).toISOString(),
          }
        : {}),
    };
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

    const stoppedAtMs = Date.now();
    const durationMs = Math.max(0, stoppedAtMs - session.startedAtMs);
    try {
      if (session.pidRefresh) clearInterval(session.pidRefresh);
      if (session.pidRefreshInFlight) {
        await session.pidRefreshInFlight.catch(() => undefined);
      }

      const stillRunning = () =>
        session.process.exitCode === null &&
        session.process.signalCode === null;

      if (stillRunning()) {
        session.process.kill("SIGINT");
      }
      await Promise.race([
        new Promise<void>((resolve) =>
          session.process.once("exit", () => resolve()),
        ),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
      // After a signal exit, Node sets signalCode and leaves exitCode null.
      if (stillRunning()) {
        session.process.kill("SIGKILL");
        await Promise.race([
          new Promise<void>((resolve) =>
            session.process.once("exit", () => resolve()),
          ),
          new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
        ]);
      }

      await Promise.allSettled([
        finished(session.out),
        session.process.stdout
          ? finished(session.process.stdout)
          : Promise.resolve(),
      ]);
      if (!session.out.closed) {
        await new Promise<void>((resolve) => session.out.end(() => resolve()));
      }

      const maxLines = options.maxLines ?? 2_000;
      const text = await readFile(session.pathHint, "utf8");
      const allLines = text.split(/\r?\n/).filter((line) => line.length > 0);
      const truncated = allLines.length > maxLines;
      const lines = truncated ? allLines.slice(-maxLines) : allLines;
      const details = await stat(session.pathHint);

      return {
        logSessionId,
        serial,
        path: session.pathHint,
        artifactUri: this.artifacts.uriFor(session.localName),
        sizeBytes: details.size,
        durationMs,
        startedAtIso: new Date(session.startedAtMs).toISOString(),
        stoppedAtIso: new Date(stoppedAtMs).toISOString(),
        lines,
        lineCount: allLines.length,
        truncated,
        ...(session.boundRecordId
          ? { boundRecordId: session.boundRecordId }
          : {}),
        ...(session.boundRecordStartedAtMs !== undefined
          ? {
              boundRecordStartedAtIso: new Date(
                session.boundRecordStartedAtMs,
              ).toISOString(),
            }
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

export async function refreshPackagePids(
  adb: AdbRunner,
  serial: string,
  packages: Set<string>,
  into: Set<number>,
): Promise<void> {
  const next = new Set<number>();
  await Promise.all(
    [...packages].map(async (packageName) => {
      try {
        const text = await adb.text(["shell", "pidof", packageName], {
          serial,
          timeoutMs: 5_000,
        });
        for (const part of text.trim().split(/\s+/)) {
          const pid = Number(part);
          if (Number.isInteger(pid) && pid > 0) next.add(pid);
        }
      } catch {
        // Package may not be running yet (cold start).
      }
    }),
  );
  into.clear();
  for (const pid of next) into.add(pid);
}

/**
 * Keep lines from known package PIDs (threadtime field) or lines that mention
 * the package name (ActivityManager / system breadcrumbs). PIDs are refreshed
 * about once per second; logs from a brand-new process may be missed until the
 * next refresh unless the line includes the package name.
 */
export function createPackageLineFilter(
  packages: Set<string>,
  getPids: () => Set<number>,
): Transform {
  let carry = "";
  return new Transform({
    transform(chunk: Buffer, _enc, callback) {
      carry += chunk.toString("utf8");
      const parts = carry.split(/\r?\n/);
      carry = parts.pop() ?? "";
      let out = "";
      for (const line of parts) {
        if (!line) continue;
        if (lineMatchesPackageFilter(line, packages, getPids())) {
          out += `${line}\n`;
        }
      }
      callback(null, out);
    },
    flush(callback) {
      if (carry && lineMatchesPackageFilter(carry, packages, getPids())) {
        callback(null, `${carry}\n`);
        return;
      }
      callback();
    },
  });
}

export function lineMatchesPackageFilter(
  line: string,
  packages: Set<string>,
  pids: Set<number>,
): boolean {
  const pidMatch = line.match(THREADTIME_PID)?.[1];
  if (pidMatch && pids.has(Number(pidMatch))) return true;
  for (const packageName of packages) {
    if (line.includes(packageName)) return true;
  }
  return false;
}
