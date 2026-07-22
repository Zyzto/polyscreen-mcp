import { randomUUID } from "node:crypto";

import { abortableDelay } from "../utils/abortable-delay.js";
import { AndroidController } from "./android-controller.js";

export const DEFAULT_FOCUS_INTERVAL_MS = 250;
/** Covers 180s @ 250ms with headroom so default max-duration traces do not ring-evict. */
export const DEFAULT_FOCUS_MAX_SAMPLES = 800;

export interface FocusDisplayState {
  packageName?: string | undefined;
  activity?: string | undefined;
  taskId?: number | undefined;
  focusedWindow?: string | undefined;
}

export interface FocusSamplePoint {
  tMs: number;
  wallClockIso: string;
  recordOffsetMs?: number | undefined;
  displays: Record<string, FocusDisplayState>;
}

export interface FocusChangeEvent {
  tMs: number;
  wallClockIso: string;
  recordOffsetMs?: number | undefined;
  /** Display IDs whose focus changed at this sample. */
  displays: Record<
    string,
    {
      from?: FocusDisplayState | undefined;
      to: FocusDisplayState;
    }
  >;
}

export interface ActiveFocusTrace {
  focusSessionId: string;
  serial: string;
  displayIds: number[];
  sampleIntervalMs: number;
  maxSamples: number;
  startedAtMs: number;
  startedAtIso: string;
  boundRecordId?: string | undefined;
  recordStartedAtMs?: number | undefined;
  samples: FocusSamplePoint[];
  droppedSamples: number;
  loop: Promise<void>;
  abort: AbortController;
}

export interface StoppedFocusTrace {
  [key: string]: unknown;
  focusSessionId: string;
  serial: string;
  displayIds: number[];
  durationMs: number;
  sampleIntervalMs: number;
  sampleCount: number;
  truncated: boolean;
  droppedSamples: number;
  startedAtIso: string;
  stoppedAtIso: string;
  boundRecordId?: string | undefined;
  /** Compact focus transitions (preferred for agents). */
  changes: FocusChangeEvent[];
  changeCount: number;
  samples: FocusSamplePoint[];
  samplesArtifactUri?: string | undefined;
  responseCompacted?: boolean | undefined;
}

export interface FocusSessionStatus {
  focusSessionId: string;
  serial: string;
  displayIds: number[];
  sampleIntervalMs: number;
  sampleCount: number;
  maxSamples: number;
  startedAtIso: string;
  elapsedMs: number;
  boundRecordId?: string | undefined;
}

export class FocusTraceSessionManager {
  readonly #sessions = new Map<string, ActiveFocusTrace>();

  constructor(readonly controller: AndroidController) {}

  get(focusSessionId: string): ActiveFocusTrace | undefined {
    return this.#sessions.get(focusSessionId);
  }

  listActive(serial?: string): FocusSessionStatus[] {
    const now = Date.now();
    return [...this.#sessions.values()]
      .filter((session) => !serial || session.serial === serial)
      .filter((session) => !session.abort.signal.aborted)
      .map((session) => ({
        focusSessionId: session.focusSessionId,
        serial: session.serial,
        displayIds: session.displayIds,
        sampleIntervalMs: session.sampleIntervalMs,
        sampleCount: session.samples.length,
        maxSamples: session.maxSamples,
        startedAtIso: session.startedAtIso,
        elapsedMs: Math.max(0, now - session.startedAtMs),
        ...(session.boundRecordId
          ? { boundRecordId: session.boundRecordId }
          : {}),
      }))
      .sort((a, b) => a.serial.localeCompare(b.serial));
  }

  start(
    serial: string,
    displayIds: number[],
    sampleIntervalMs = DEFAULT_FOCUS_INTERVAL_MS,
    options: {
      boundRecordId?: string | undefined;
      recordStartedAtMs?: number | undefined;
      maxSamples?: number | undefined;
    } = {},
  ): { focusSessionId: string; startedAtIso: string } {
    const unique = [...new Set(displayIds)];
    if (unique.length === 0) {
      throw new Error("focus_trace_start requires at least one displayId");
    }
    const existing = [...this.#sessions.values()].find(
      (session) => session.serial === serial && !session.abort.signal.aborted,
    );
    if (existing) {
      throw new Error(
        `Focus trace already active on ${serial} (${existing.focusSessionId})`,
      );
    }

    const focusSessionId = randomUUID();
    const startedAtMs = Date.now();
    const abort = new AbortController();
    const interval = Math.max(50, Math.min(5_000, sampleIntervalMs));
    const maxSamples = Math.max(
      1,
      Math.min(5_000, options.maxSamples ?? DEFAULT_FOCUS_MAX_SAMPLES),
    );

    const session: ActiveFocusTrace = {
      focusSessionId,
      serial,
      displayIds: unique,
      sampleIntervalMs: interval,
      maxSamples,
      startedAtMs,
      startedAtIso: new Date(startedAtMs).toISOString(),
      samples: [],
      droppedSamples: 0,
      abort,
      loop: Promise.resolve(),
      ...(options.boundRecordId
        ? { boundRecordId: options.boundRecordId }
        : {}),
      ...(options.recordStartedAtMs !== undefined
        ? { recordStartedAtMs: options.recordStartedAtMs }
        : {}),
    };

    session.loop = this.runLoop(session);
    this.#sessions.set(focusSessionId, session);
    return {
      focusSessionId,
      startedAtIso: session.startedAtIso,
    };
  }

  async stop(
    serial: string,
    focusSessionId: string,
  ): Promise<StoppedFocusTrace> {
    const session = this.#sessions.get(focusSessionId);
    if (!session || session.serial !== serial) {
      throw new Error(`Unknown focus session ${focusSessionId} on ${serial}`);
    }
    session.abort.abort();
    await session.loop.catch(() => undefined);
    this.#sessions.delete(focusSessionId);
    const stoppedAtMs = Date.now();
    const changes = summarizeFocusChanges(session.samples);
    return {
      focusSessionId,
      serial,
      displayIds: session.displayIds,
      durationMs: Math.max(0, stoppedAtMs - session.startedAtMs),
      sampleIntervalMs: session.sampleIntervalMs,
      sampleCount: session.samples.length,
      truncated: session.droppedSamples > 0,
      droppedSamples: session.droppedSamples,
      startedAtIso: session.startedAtIso,
      stoppedAtIso: new Date(stoppedAtMs).toISOString(),
      changes,
      changeCount: changes.length,
      samples: session.samples,
      ...(session.boundRecordId
        ? { boundRecordId: session.boundRecordId }
        : {}),
    };
  }

  async runFor(
    serial: string,
    displayIds: number[],
    durationMs: number,
    sampleIntervalMs = DEFAULT_FOCUS_INTERVAL_MS,
    signal?: AbortSignal,
    options: { maxSamples?: number | undefined } = {},
  ): Promise<StoppedFocusTrace> {
    const started = this.start(serial, displayIds, sampleIntervalMs, options);
    try {
      await abortableDelay(Math.max(100, durationMs), signal);
    } catch {
      // Caller cancelled; still stop and return collected samples.
    }
    return await this.stop(serial, started.focusSessionId);
  }

  async stopAll(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    await Promise.allSettled(
      sessions.map((session) =>
        this.stop(session.serial, session.focusSessionId),
      ),
    );
  }

  private async runLoop(session: ActiveFocusTrace): Promise<void> {
    while (!session.abort.signal.aborted) {
      try {
        const displays = await this.controller.sampleFocus(
          session.serial,
          session.displayIds,
          session.abort.signal,
        );
        const now = Date.now();
        session.samples.push({
          tMs: Math.max(0, now - session.startedAtMs),
          wallClockIso: new Date(now).toISOString(),
          displays,
          ...(session.recordStartedAtMs !== undefined
            ? {
                recordOffsetMs: Math.max(0, now - session.recordStartedAtMs),
              }
            : {}),
        });
        if (session.samples.length > session.maxSamples) {
          const drop = session.samples.length - session.maxSamples;
          session.samples.splice(0, drop);
          session.droppedSamples += drop;
        }
      } catch {
        if (session.abort.signal.aborted) break;
      }
      if (session.abort.signal.aborted) break;
      try {
        await abortableDelay(session.sampleIntervalMs, session.abort.signal);
      } catch {
        break;
      }
    }
  }
}

export function summarizeFocusChanges(
  samples: FocusSamplePoint[],
): FocusChangeEvent[] {
  const changes: FocusChangeEvent[] = [];
  let previous: FocusSamplePoint | undefined;
  for (const sample of samples) {
    if (!previous) {
      previous = sample;
      continue;
    }

    const displays: FocusChangeEvent["displays"] = {};
    const ids = new Set([
      ...Object.keys(previous.displays),
      ...Object.keys(sample.displays),
    ]);
    for (const displayId of ids) {
      const from = previous.displays[displayId];
      const to = sample.displays[displayId];
      // Skip incomplete samples so dump flakes do not look like focus loss.
      if (from === undefined || to === undefined) continue;
      if (!sameFocusState(from, to)) {
        displays[displayId] = { from, to };
      }
    }
    if (Object.keys(displays).length > 0) {
      changes.push({
        tMs: sample.tMs,
        wallClockIso: sample.wallClockIso,
        displays,
        ...(sample.recordOffsetMs !== undefined
          ? { recordOffsetMs: sample.recordOffsetMs }
          : {}),
      });
    }
    previous = sample;
  }
  return changes;
}

function sameFocusState(a: FocusDisplayState, b: FocusDisplayState): boolean {
  return (
    a.packageName === b.packageName &&
    a.activity === b.activity &&
    a.taskId === b.taskId &&
    a.focusedWindow === b.focusedWindow
  );
}
