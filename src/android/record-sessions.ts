import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { ArtifactStore } from "../artifacts/store.js";
import { abortableDelay } from "../utils/abortable-delay.js";
import { AdbRunner, quoteRemoteShellArg } from "./adb-runner.js";

const SAFE_LABEL = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_RECORD_SECONDS = 180;

export interface RecordMark {
  label: string;
  offsetMs: number;
  wallClockIso: string;
}

export interface ActiveRecording {
  recordId: string;
  serial: string;
  displayId: number;
  physicalDisplayId: string;
  remotePath: string;
  localName: string;
  pathHint: string;
  startedAtMs: number;
  remotePid: number;
  marks: RecordMark[];
  /** True once on-device screenrecord has been confirmed alive. */
  ready: boolean;
  /** First successful finalize timestamp; preserved across pull retries. */
  stoppedAtMs?: number | undefined;
}

export interface StoppedRecording {
  recordId: string;
  serial: string;
  displayId: number;
  physicalDisplayId: string;
  path: string;
  artifactUri: string;
  sizeBytes: number;
  durationMs: number;
  startedAtIso: string;
  stoppedAtIso: string;
  marks: RecordMark[];
}

export interface RecordingSessionStatus {
  recordId: string;
  serial: string;
  displayId: number;
  physicalDisplayId: string;
  ready: boolean;
  /** True after the first stop attempt (waiting for pull retry). */
  stopping: boolean;
  startedAtIso: string;
  elapsedMs: number;
  markCount: number;
  pathHint: string;
}

export type ScreenrecordPidStatus = "ours" | "gone" | "uncertain";

export class RecordingSessionManager {
  readonly #byId = new Map<string, ActiveRecording>();
  readonly #bySlot = new Map<string, string>();
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

  active(serial: string, displayId: number): ActiveRecording | undefined {
    const recordId = this.#bySlot.get(slotKey(serial, displayId));
    return recordId ? this.#byId.get(recordId) : undefined;
  }

  get(recordId: string): ActiveRecording | undefined {
    return this.#byId.get(recordId);
  }

  listActive(serial?: string): RecordingSessionStatus[] {
    const now = Date.now();
    return [...this.#byId.values()]
      .filter((session) => !serial || session.serial === serial)
      .map((session) => ({
        recordId: session.recordId,
        serial: session.serial,
        displayId: session.displayId,
        physicalDisplayId: session.physicalDisplayId,
        ready: session.ready,
        stopping: session.stoppedAtMs !== undefined,
        startedAtIso: new Date(session.startedAtMs).toISOString(),
        elapsedMs: Math.max(
          0,
          (session.stoppedAtMs ?? now) - session.startedAtMs,
        ),
        markCount: session.marks.length,
        pathHint: session.pathHint,
      }))
      .sort(
        (a, b) => a.serial.localeCompare(b.serial) || a.displayId - b.displayId,
      );
  }

  async start(
    serial: string,
    displayId: number,
    physicalDisplayId: string,
    signal?: AbortSignal,
  ): Promise<{
    recordId: string;
    pathHint: string;
    displayId: number;
    physicalDisplayId: string;
    startedAtIso: string;
  }> {
    if (!/^\d+$/.test(physicalDisplayId)) {
      throw new Error("Invalid physical display ID");
    }
    const slot = slotKey(serial, displayId);
    if (this.#bySlot.has(slot)) {
      throw new Error(
        `Recording already active on ${serial} display ${displayId}`,
      );
    }

    // Reserve the slot synchronously so concurrent starts cannot double-spawn.
    const recordId = randomUUID();
    const localName = `recording-${Date.now()}-${displayId}-${recordId}.mp4`;
    const remotePath = `/data/local/tmp/${localName}`;
    const pathHint = join(this.artifactRoot, localName);
    const session: ActiveRecording = {
      recordId,
      serial,
      displayId,
      physicalDisplayId,
      remotePath,
      localName,
      pathHint,
      startedAtMs: Date.now(),
      remotePid: 0,
      marks: [],
      ready: false,
    };
    this.#byId.set(recordId, session);
    this.#bySlot.set(slot, recordId);

    try {
      await mkdir(this.artifactRoot, { recursive: true });

      // Background on-device so the host queue stays free for interleaved input.
      session.startedAtMs = Date.now();
      // ADB joins argv into a single device-side command line, so the script has
      // to reach the device as one quoted word or `sh -c` would only take
      // "screenrecord" as its script and drop every argument after it.
      const script = `screenrecord --display-id ${physicalDisplayId} --time-limit ${MAX_RECORD_SECONDS} ${quoteRemoteShellArg(remotePath)} >/dev/null 2>&1 & echo $!`;
      const pidText = await this.adb.text(
        ["shell", "sh", "-c", quoteRemoteShellArg(script)],
        { serial, signal, timeoutMs: 15_000 },
      );
      const remotePid = Number(pidText.trim().split(/\r?\n/).at(-1));
      if (!Number.isInteger(remotePid) || remotePid <= 0) {
        throw new Error(`screenrecord did not return a PID: ${pidText}`);
      }
      session.remotePid = remotePid;

      // Confirm the process is still our screenrecord briefly after start.
      await abortableDelay(150, signal);
      const alive =
        (await this.probeScreenrecordPid(
          serial,
          remotePid,
          remotePath,
          signal,
        )) === "ours";
      if (!alive) {
        await this.adb
          .run(["shell", "rm", "-f", remotePath], { serial, timeoutMs: 10_000 })
          .catch(() => undefined);
        throw new Error(
          `screenrecord exited immediately on display ${displayId} (physical ${physicalDisplayId})`,
        );
      }

      session.ready = true;
      return {
        recordId,
        pathHint,
        displayId,
        physicalDisplayId,
        startedAtIso: new Date(session.startedAtMs).toISOString(),
      };
    } catch (error) {
      await this.abortReserved(session).catch(() => undefined);
      throw error;
    }
  }

  mark(serial: string, recordId: string, label: string): RecordMark {
    const session = this.requireSession(serial, recordId);
    if (!session.ready) {
      throw new Error(`Recording session ${recordId} is still starting`);
    }
    if (session.stoppedAtMs !== undefined) {
      throw new Error(
        `Recording session ${recordId} is already stopping; cannot mark`,
      );
    }
    if (!SAFE_LABEL.test(label)) {
      throw new Error(
        `Invalid mark label (use 1-64 chars of A-Za-z0-9_.:-): ${label}`,
      );
    }
    const now = Date.now();
    const mark: RecordMark = {
      label,
      offsetMs: Math.max(0, now - session.startedAtMs),
      wallClockIso: new Date(now).toISOString(),
    };
    session.marks.push(mark);
    return mark;
  }

  async stop(
    serial: string,
    recordId: string,
    signal?: AbortSignal,
  ): Promise<StoppedRecording> {
    const session = this.requireSession(serial, recordId);
    if (!session.ready) {
      throw new Error(`Recording session ${recordId} is still starting`);
    }
    // Preserve first stop clock across pull retries so duration stays honest.
    const stoppedAtMs = session.stoppedAtMs ?? Date.now();
    session.stoppedAtMs = stoppedAtMs;
    const durationMs = Math.max(0, stoppedAtMs - session.startedAtMs);

    // Only signal when cmdline still identifies *this* screenrecord. Never kill
    // on "uncertain" — PID reuse after time-limit exit is worse than a pull retry.
    if (
      (await this.probeScreenrecordPid(
        serial,
        session.remotePid,
        session.remotePath,
        signal,
      )) === "ours"
    ) {
      await this.adb
        .run(["shell", "kill", "-INT", String(session.remotePid)], {
          serial,
          signal,
          timeoutMs: 10_000,
        })
        .catch(() => undefined);
    }

    // Allow screenrecord to finalize the MP4 container (exponential backoff).
    const deadline = Date.now() + 5_000;
    let delayMs = 50;
    while (Date.now() < deadline) {
      const status = await this.probeScreenrecordPid(
        serial,
        session.remotePid,
        session.remotePath,
        signal,
      );
      if (status !== "ours") break;
      await abortableDelay(delayMs, signal);
      delayMs = Math.min(800, delayMs * 2);
    }
    if (
      (await this.probeScreenrecordPid(
        serial,
        session.remotePid,
        session.remotePath,
        signal,
      )) === "ours"
    ) {
      await this.adb
        .run(["shell", "kill", "-KILL", String(session.remotePid)], {
          serial,
          timeoutMs: 10_000,
        })
        .catch(() => undefined);
      await abortableDelay(200, signal);
    }

    const destination = join(this.artifactRoot, session.localName);
    // On pull failure the session stays mapped so the agent can retry stop.
    await this.adb.run(["pull", session.remotePath, destination], {
      serial,
      signal,
      timeoutMs: 120_000,
    });
    const details = await stat(destination);
    const marksPath = destination.replace(/\.mp4$/i, ".marks.json");
    await writeFile(
      marksPath,
      JSON.stringify({
        recordId: session.recordId,
        serial: session.serial,
        displayId: session.displayId,
        physicalDisplayId: session.physicalDisplayId,
        startedAtMs: session.startedAtMs,
        startedAtIso: new Date(session.startedAtMs).toISOString(),
        stoppedAtIso: new Date(stoppedAtMs).toISOString(),
        durationMs,
        marks: session.marks,
      }),
      "utf8",
    );

    this.#byId.delete(recordId);
    this.#bySlot.delete(slotKey(serial, session.displayId));
    await this.adb
      .run(["shell", "rm", "-f", session.remotePath], {
        serial,
        timeoutMs: 10_000,
      })
      .catch(() => undefined);

    return {
      recordId: session.recordId,
      serial: session.serial,
      displayId: session.displayId,
      physicalDisplayId: session.physicalDisplayId,
      path: destination,
      artifactUri: this.artifacts.uriFor(session.localName),
      sizeBytes: details.size,
      durationMs,
      startedAtIso: new Date(session.startedAtMs).toISOString(),
      stoppedAtIso: new Date(stoppedAtMs).toISOString(),
      marks: [...session.marks],
    };
  }

  async stopAll(): Promise<void> {
    const sessions = [...this.#byId.values()].filter(
      (session) => session.ready,
    );
    await Promise.allSettled(
      sessions.map((session) => this.stop(session.serial, session.recordId)),
    );
    // Drop any reserved-but-not-ready leftovers.
    for (const session of [...this.#byId.values()]) {
      if (!session.ready) {
        await this.abortReserved(session).catch(() => undefined);
      }
    }
  }

  private async abortReserved(session: ActiveRecording): Promise<void> {
    this.#byId.delete(session.recordId);
    this.#bySlot.delete(slotKey(session.serial, session.displayId));
    if (
      session.remotePid > 0 &&
      (await this.probeScreenrecordPid(
        session.serial,
        session.remotePid,
        session.remotePath,
      )) === "ours"
    ) {
      await this.adb
        .run(["shell", "kill", "-KILL", String(session.remotePid)], {
          serial: session.serial,
          timeoutMs: 10_000,
        })
        .catch(() => undefined);
    }
    await this.adb
      .run(["shell", "rm", "-f", session.remotePath], {
        serial: session.serial,
        timeoutMs: 10_000,
      })
      .catch(() => undefined);
  }

  private requireSession(serial: string, recordId: string): ActiveRecording {
    const session = this.#byId.get(recordId);
    if (!session || session.serial !== serial) {
      throw new Error(`Unknown recording session ${recordId} on ${serial}`);
    }
    return session;
  }

  /**
   * Identify the recording PID:
   * - ours: cmdline matches this session's screenrecord path
   * - gone: process missing or cmdline belongs to something else
   * - uncertain: adb/cmdline flake while kill -0 still succeeds (retry/stop
   *   should still signal so we do not pull a live recording)
   */
  private async probeScreenrecordPid(
    serial: string,
    pid: number,
    remotePath: string,
    signal?: AbortSignal,
  ): Promise<ScreenrecordPidStatus> {
    if (!Number.isInteger(pid) || pid <= 0) return "gone";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const raw = await this.adb.text(
          ["shell", "cat", `/proc/${pid}/cmdline`],
          { serial, signal, timeoutMs: 5_000 },
        );
        if (cmdlineLooksLikeScreenrecord(raw, remotePath)) return "ours";
        // Readable cmdline that is not our screenrecord → do not signal.
        if (raw.replaceAll("\0", " ").trim()) return "gone";
      } catch {
        if (signal?.aborted) throw signal.reason;
      }
      if (!(await this.isPidAlive(serial, pid, signal))) return "gone";
      if (attempt < 2) await abortableDelay(80, signal);
    }
    return "uncertain";
  }

  private async isPidAlive(
    serial: string,
    pid: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      await this.adb.run(["shell", "kill", "-0", String(pid)], {
        serial,
        signal,
        timeoutMs: 5_000,
      });
      return true;
    } catch {
      if (signal?.aborted) throw signal.reason;
      return false;
    }
  }
}

export function cmdlineLooksLikeScreenrecord(
  cmdlineRaw: string,
  remotePath: string,
): boolean {
  const cmdline = cmdlineRaw.replaceAll("\0", " ").trim();
  if (!cmdline) return false;
  const file = basename(remotePath);
  // Prefer path token match; require screenrecord binary name as its own token.
  const tokens = cmdline.split(/\s+/);
  const hasBinary = tokens.some(
    (token) => token === "screenrecord" || token.endsWith("/screenrecord"),
  );
  const hasPath =
    tokens.includes(remotePath) ||
    tokens.some((token) => token === file || token.endsWith(`/${file}`));
  return hasBinary && hasPath;
}

function slotKey(serial: string, displayId: number): string {
  return `${serial}\0${displayId}`;
}
