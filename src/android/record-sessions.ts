import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { abortableDelay } from "../utils/abortable-delay.js";
import { AdbRunner, quoteRemoteShellArg } from "./adb-runner.js";

const SAFE_LABEL = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_RECORD_SECONDS = 180;

export interface RecordMark {
  label: string;
  offsetMs: number;
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
  marks: RecordMark[];
}

export class RecordingSessionManager {
  readonly #byId = new Map<string, ActiveRecording>();
  readonly #bySlot = new Map<string, string>();

  constructor(
    readonly adb = new AdbRunner(),
    readonly artifactRoot: string,
  ) {}

  active(serial: string, displayId: number): ActiveRecording | undefined {
    const recordId = this.#bySlot.get(slotKey(serial, displayId));
    return recordId ? this.#byId.get(recordId) : undefined;
  }

  get(recordId: string): ActiveRecording | undefined {
    return this.#byId.get(recordId);
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

    await mkdir(this.artifactRoot, { recursive: true });
    const recordId = randomUUID();
    const localName = `recording-${Date.now()}-${displayId}-${recordId}.mp4`;
    const remotePath = `/data/local/tmp/${localName}`;
    const pathHint = join(this.artifactRoot, localName);

    // Background on-device so the host queue stays free for interleaved input.
    const pidText = await this.adb.text(
      [
        "shell",
        "sh",
        "-c",
        `screenrecord --display-id ${physicalDisplayId} --time-limit ${MAX_RECORD_SECONDS} ${quoteRemoteShellArg(remotePath)} >/dev/null 2>&1 & echo $!`,
      ],
      { serial, signal, timeoutMs: 15_000 },
    );
    const remotePid = Number(pidText.trim().split(/\r?\n/).at(-1));
    if (!Number.isInteger(remotePid) || remotePid <= 0) {
      throw new Error(`screenrecord did not return a PID: ${pidText}`);
    }

    // Confirm the process is still alive briefly after start.
    await abortableDelay(150, signal);
    const alive = await this.isPidAlive(serial, remotePid, signal);
    if (!alive) {
      await this.adb
        .run(["shell", "rm", "-f", remotePath], { serial, timeoutMs: 10_000 })
        .catch(() => undefined);
      throw new Error(
        `screenrecord exited immediately on display ${displayId} (physical ${physicalDisplayId})`,
      );
    }

    const session: ActiveRecording = {
      recordId,
      serial,
      displayId,
      physicalDisplayId,
      remotePath,
      localName,
      pathHint,
      startedAtMs: Date.now(),
      remotePid,
      marks: [],
    };
    this.#byId.set(recordId, session);
    this.#bySlot.set(slot, recordId);
    return {
      recordId,
      pathHint,
      displayId,
      physicalDisplayId,
    };
  }

  mark(serial: string, recordId: string, label: string): RecordMark {
    const session = this.requireSession(serial, recordId);
    if (!SAFE_LABEL.test(label)) {
      throw new Error(
        `Invalid mark label (use 1-64 chars of A-Za-z0-9_.:-): ${label}`,
      );
    }
    const mark: RecordMark = {
      label,
      offsetMs: Math.max(0, Date.now() - session.startedAtMs),
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
    const durationMs = Math.max(0, Date.now() - session.startedAtMs);

    try {
      if (await this.isPidAlive(serial, session.remotePid, signal)) {
        await this.adb
          .run(["shell", "kill", "-INT", String(session.remotePid)], {
            serial,
            signal,
            timeoutMs: 10_000,
          })
          .catch(() => undefined);
      }

      // Allow screenrecord to finalize the MP4 container.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (!(await this.isPidAlive(serial, session.remotePid, signal))) break;
        await abortableDelay(100, signal);
      }
      if (await this.isPidAlive(serial, session.remotePid, signal)) {
        await this.adb
          .run(["shell", "kill", "-KILL", String(session.remotePid)], {
            serial,
            timeoutMs: 10_000,
          })
          .catch(() => undefined);
        await abortableDelay(200, signal);
      }

      const destination = join(this.artifactRoot, session.localName);
      await this.adb.run(["pull", session.remotePath, destination], {
        serial,
        signal,
        timeoutMs: 120_000,
      });
      const details = await stat(destination);
      const marksPath = destination.replace(/\.mp4$/i, ".marks.json");
      await writeFile(
        marksPath,
        JSON.stringify(
          {
            recordId: session.recordId,
            serial: session.serial,
            displayId: session.displayId,
            physicalDisplayId: session.physicalDisplayId,
            startedAtMs: session.startedAtMs,
            durationMs,
            marks: session.marks,
          },
          null,
          2,
        ),
        "utf8",
      );

      return {
        recordId: session.recordId,
        serial: session.serial,
        displayId: session.displayId,
        physicalDisplayId: session.physicalDisplayId,
        path: destination,
        artifactUri: `mobile://artifacts/${encodeURIComponent(session.localName)}`,
        sizeBytes: details.size,
        durationMs,
        marks: [...session.marks],
      };
    } finally {
      this.#byId.delete(recordId);
      this.#bySlot.delete(slotKey(serial, session.displayId));
      await this.adb
        .run(["shell", "rm", "-f", session.remotePath], {
          serial,
          timeoutMs: 10_000,
        })
        .catch(() => undefined);
    }
  }

  async stopAll(): Promise<void> {
    const sessions = [...this.#byId.values()];
    await Promise.allSettled(
      sessions.map((session) => this.stop(session.serial, session.recordId)),
    );
  }

  private requireSession(serial: string, recordId: string): ActiveRecording {
    const session = this.#byId.get(recordId);
    if (!session || session.serial !== serial) {
      throw new Error(`Unknown recording session ${recordId} on ${serial}`);
    }
    return session;
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

function slotKey(serial: string, displayId: number): string {
  return `${serial}\0${displayId}`;
}
