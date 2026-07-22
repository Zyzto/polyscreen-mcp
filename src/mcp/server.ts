import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { AdbProfiles } from "../android/adb-profiles.js";
import { AndroidController } from "../android/android-controller.js";
import {
  DEFAULT_FOCUS_INTERVAL_MS,
  DEFAULT_FOCUS_MAX_SAMPLES,
  FocusTraceSessionManager,
  type StoppedFocusTrace,
} from "../android/focus-sessions.js";
import { LogcatSessionManager } from "../android/logcat-sessions.js";
import {
  analyzeRecording,
  resolveRecordingPath,
} from "../android/recording-analyze.js";
import { RecordingSessionManager } from "../android/record-sessions.js";
import { SystemOps } from "../android/system-ops.js";
import { findUiNodes, parseUiNodes } from "../android/ui.js";
import { ArtifactStore } from "../artifacts/store.js";
import { CompanionManager } from "../backends/companion.js";
import { abortableDelay } from "../utils/abortable-delay.js";
import {
  CORE_DETECTIVE_TOOLS,
  PACKAGE_NAME,
  PACKAGE_VERSION,
} from "../version.js";
import {
  displayIdSchema,
  envelopeOutputSchema,
  packageSchema,
  pointSchema,
  serialSchema,
} from "./schemas.js";

export interface PolyScreenServerOptions {
  controller?: AndroidController;
  companion?: CompanionManager;
  adbProfiles?: AdbProfiles;
  artifacts?: ArtifactStore;
  recordings?: RecordingSessionManager;
  logcats?: LogcatSessionManager;
  focusTraces?: FocusTraceSessionManager;
  systemOps?: SystemOps;
  profiles?: ReadonlySet<string>;
}

export type PolyScreenMcpServer = McpServer & {
  listRegisteredTools: () => string[];
  notifyToolListChanged: () => void;
};

/** Compact JSON in tool text payloads — agents parse structuredContent anyway. */
const jsonContent = (value: unknown) => [
  { type: "text" as const, text: JSON.stringify(value) },
];

const INLINE_FOCUS_SAMPLE_LIMIT = 120;

async function compactFocusResult(
  artifacts: ArtifactStore,
  stopped: StoppedFocusTrace,
  includeAllSamples: boolean,
): Promise<StoppedFocusTrace> {
  if (
    includeAllSamples ||
    stopped.samples.length <= INLINE_FOCUS_SAMPLE_LIMIT
  ) {
    return stopped;
  }
  const payload = Buffer.from(JSON.stringify(stopped.samples), "utf8");
  const saved = await artifacts.save(
    payload,
    ".json",
    `focus-${stopped.focusSessionId.slice(0, 8)}`,
  );
  return {
    ...stopped,
    samples: stopped.samples.slice(0, INLINE_FOCUS_SAMPLE_LIMIT),
    samplesArtifactUri: saved.uri,
    // Keep ring-buffer truncated meaning; also note response was compacted.
    responseCompacted: true,
  };
}

function marksNearRuns<
  T extends {
    label: string;
    offsetMs: number;
    wallClockIso?: string | undefined;
  },
>(
  marks: T[],
  runs: Array<{ startMs: number; endMs: number }>,
  windowMs: number,
): T[] {
  return marks.filter((mark) =>
    runs.some(
      (run) =>
        mark.offsetMs >= run.startMs - windowMs &&
        mark.offsetMs <= run.endMs + windowMs,
    ),
  );
}

const mutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export function createPolyScreenServer(
  options: PolyScreenServerOptions = {},
): PolyScreenMcpServer {
  const controller = options.controller ?? new AndroidController();
  const companion = options.companion ?? new CompanionManager(controller.adb);
  const adbProfiles = options.adbProfiles ?? new AdbProfiles(controller.adb);
  const artifacts =
    options.artifacts ?? new ArtifactStore(adbProfiles.artifactRoot);
  const recordings =
    options.recordings ??
    new RecordingSessionManager(controller.adb, artifacts);
  const logcats =
    options.logcats ?? new LogcatSessionManager(controller.adb, artifacts);
  const focusTraces =
    options.focusTraces ?? new FocusTraceSessionManager(controller);
  const systemOps = options.systemOps ?? new SystemOps(controller.adb);
  const profiles = options.profiles ?? new Set(["core"]);
  const registeredToolNames: string[] = [];
  const server = new McpServer({
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
  }) as PolyScreenMcpServer;
  const registerTool = server.registerTool.bind(server);
  server.registerTool = ((name: string, ...rest: unknown[]) => {
    registeredToolNames.push(name);
    return (registerTool as (...args: unknown[]) => unknown)(name, ...rest);
  }) as typeof server.registerTool;

  const requireBoundRecording = (
    serial: string,
    boundRecordId: string | undefined,
  ): { recordId: string; startedAtMs: number } | undefined => {
    if (!boundRecordId) return undefined;
    const recording = recordings.get(boundRecordId);
    if (!recording || recording.serial !== serial) {
      throw new Error(`Unknown bound recordId: ${boundRecordId}`);
    }
    return { recordId: boundRecordId, startedAtMs: recording.startedAtMs };
  };

  const listedTools = (): string[] => [...registeredToolNames].sort();

  server.registerResource(
    "mobile-artifacts",
    new ResourceTemplate("mobile://artifacts/{name}", {
      list: async () => ({
        // Metadata stubs only — never embed PNG/MP4 bytes in listings.
        resources: (await artifacts.list()).map((artifact) => ({
          uri: artifact.uri,
          name: artifact.name,
          mimeType: artifact.mimeType,
          description: `${artifact.sizeBytes} bytes, modified ${artifact.modifiedAt}`,
        })),
      }),
    }),
    {
      title: "PolyScreen MCP artifacts",
      description:
        "Metadata stubs for screenshots, recordings, logs, and traces on disk. Prefer mobile_analyze_recording JSON over fetching binary resources when hunting flashes.",
    },
    async (uri, variables) => {
      const name = decodeURIComponent(String(variables.name));
      const artifact = await artifacts.read(name);
      return {
        contents: [
          {
            uri: uri.href,
            blob: artifact.data.toString("base64"),
            mimeType: artifact.metadata.mimeType,
          },
        ],
      };
    },
  );

  server.registerTool(
    "mobile_server_info",
    {
      title: "PolyScreen server info",
      description:
        "Return package version, active profiles, and the exact registered tool list. Call after reconnect to verify Cursor sees the full core surface.",
      inputSchema: {},
      outputSchema: {
        name: z.string(),
        version: z.string(),
        profiles: z.array(z.string()),
        toolCount: z.number(),
        toolNames: z.array(z.string()),
        artifactRoot: z.string(),
      },
      annotations: readAnnotations,
    },
    async () => {
      const toolNames = listedTools();
      const result = {
        name: PACKAGE_NAME,
        version: PACKAGE_VERSION,
        profiles: [...profiles].sort(),
        toolCount: toolNames.length,
        toolNames,
        artifactRoot: artifacts.root,
      };
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_devices_list",
    {
      title: "List Android devices",
      description:
        "List ADB devices with reachability, hardware serial grouping, preferred TCP serial, and aliases when the same device appears under multiple serials.",
      inputSchema: {},
      outputSchema: {
        devices: z.array(
          z.object({
            serial: z.string(),
            state: z.string(),
            product: z.string().optional(),
            model: z.string().optional(),
            device: z.string().optional(),
            transportId: z.string().optional(),
            reachable: z.boolean().optional(),
            hardwareSerial: z.string().optional(),
            preferredSerial: z.string().optional(),
            preferred: z.boolean().optional(),
            aliases: z.array(z.string()).optional(),
          }),
        ),
      },
      annotations: readAnnotations,
    },
    async (_input, extra) => {
      const result = { devices: await controller.listDevices(extra.signal) };
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_device_inspect",
    {
      title: "Inspect Android capabilities",
      description:
        "Probe the selected device's actual ADB, input, command, build, and backend capabilities.",
      inputSchema: {
        serial: serialSchema,
        refresh: z.boolean().default(false),
      },
      outputSchema: { capabilities: z.record(z.string(), z.unknown()) },
      annotations: readAnnotations,
    },
    async ({ serial, refresh }, extra) => {
      const result = {
        capabilities: await controller.inspectDevice(serial, {
          refresh,
          signal: extra.signal,
        }),
      };
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_displays_list",
    {
      title: "List Android displays",
      description:
        "List logical displays and correlated physical capture IDs with evidence and focus state.",
      inputSchema: { serial: serialSchema },
      outputSchema: { displays: z.array(z.record(z.string(), z.unknown())) },
      annotations: readAnnotations,
    },
    async ({ serial }, extra) => {
      const result = {
        displays: await controller.listDisplays(serial, extra.signal),
      };
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_screen_capture",
    {
      title: "Capture an Android display",
      description:
        "Capture one logical display after resolving its SurfaceFlinger physical display ID.",
      inputSchema: {
        serial: serialSchema,
        displayId: displayIdSchema,
        saveArtifact: z.boolean().default(false),
      },
      outputSchema: {
        serial: z.string(),
        display: z.record(z.string(), z.unknown()),
        mimeType: z.literal("image/png"),
        sizeBytes: z.number(),
        durationMs: z.number(),
        artifactUri: z.string().optional(),
      },
      annotations: mutationAnnotations,
    },
    async ({ serial, displayId, saveArtifact }, extra) => {
      const capture = await controller.captureScreen(
        serial,
        displayId,
        extra.signal,
      );
      const artifact = saveArtifact
        ? await artifacts.save(capture.png, ".png", `display-${displayId}`)
        : undefined;
      const metadata = {
        serial,
        display: capture.display,
        mimeType: "image/png" as const,
        sizeBytes: capture.png.length,
        durationMs: capture.durationMs,
        ...(artifact ? { artifactUri: artifact.uri } : {}),
      };
      return {
        content: [
          {
            type: "image",
            data: capture.png.toString("base64"),
            mimeType: "image/png",
          },
          ...jsonContent(metadata),
        ],
        structuredContent: metadata,
      };
    },
  );

  server.registerTool(
    "mobile_screen_record",
    {
      title: "Record an Android display",
      description:
        "Blocking record of one physical-backed display for a bounded duration. Prefer mobile_record_start/mark/stop when input must be interleaved.",
      inputSchema: {
        serial: serialSchema,
        displayId: displayIdSchema,
        durationSeconds: z.number().int().min(1).max(180).default(10),
      },
      outputSchema: {
        serial: z.string(),
        displayId: z.number(),
        physicalDisplayId: z.string(),
        path: z.string(),
        artifactUri: z.string(),
        sizeBytes: z.number(),
      },
      annotations: { ...mutationAnnotations, openWorldHint: true },
    },
    async ({ serial, displayId, durationSeconds }, extra) => {
      const display = (
        await controller.listDisplays(serial, extra.signal)
      ).find((candidate) => candidate.logicalId === displayId);
      if (!display)
        throw new Error(`Logical display ${displayId} is unavailable`);
      if (!display.physicalId) {
        throw new Error(
          `Logical display ${displayId} has no recordable physical display`,
        );
      }
      const recording = await adbProfiles.recordDisplay(
        serial,
        display.physicalId,
        durationSeconds,
        extra.signal,
      );
      const result = {
        serial,
        displayId,
        physicalDisplayId: display.physicalId,
        ...recording,
      };
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_sessions_status",
    {
      title: "List active detective sessions",
      description:
        "Return active async recording, focus, and logcat sessions (optional serial filter). Use before stop/mark to recover IDs after a reconnect.",
      inputSchema: {
        serial: serialSchema.optional(),
      },
      outputSchema: {
        recordings: z.array(z.record(z.string(), z.unknown())),
        focusTraces: z.array(z.record(z.string(), z.unknown())),
        logcats: z.array(z.record(z.string(), z.unknown())),
      },
      annotations: readAnnotations,
    },
    async ({ serial }) => {
      const result = {
        recordings: recordings.listActive(serial),
        focusTraces: focusTraces.listActive(serial),
        logcats: logcats.listActive(serial),
      };
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_record_start",
    {
      title: "Start async display recording",
      description:
        "Start a non-blocking screenrecord on one logical display so input tools can run during capture. One active session per (serial, displayId).",
      inputSchema: {
        serial: serialSchema,
        displayId: displayIdSchema,
      },
      outputSchema: {
        recordId: z.string(),
        pathHint: z.string(),
        displayId: z.number(),
        physicalDisplayId: z.string(),
        startedAtIso: z.string(),
      },
      annotations: { ...mutationAnnotations, openWorldHint: true },
    },
    async ({ serial, displayId }, extra) => {
      await controller.requireDevice(serial, extra.signal);
      const display = (
        await controller.listDisplays(serial, extra.signal)
      ).find((candidate) => candidate.logicalId === displayId);
      if (!display)
        throw new Error(`Logical display ${displayId} is unavailable`);
      if (!display.physicalId) {
        throw new Error(
          `Logical display ${displayId} has no recordable physical display`,
        );
      }
      const result = await recordings.start(
        serial,
        displayId,
        display.physicalId,
        extra.signal,
      );
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_record_mark",
    {
      title: "Mark async recording timeline",
      description:
        "Attach a labeled timestamp (offsetMs from record start) for later correlation with analyze/focus/logcat.",
      inputSchema: {
        serial: serialSchema,
        recordId: z.string().uuid(),
        label: z
          .string()
          .regex(/^[A-Za-z0-9_.:-]{1,64}$/)
          .describe("Timeline label, e.g. pre-launch, press-a, home"),
      },
      outputSchema: {
        recordId: z.string(),
        label: z.string(),
        offsetMs: z.number(),
        wallClockIso: z.string(),
      },
      annotations: mutationAnnotations,
    },
    async ({ serial, recordId, label }) => {
      const mark = recordings.mark(serial, recordId, label);
      const result = { recordId, ...mark };
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_record_stop",
    {
      title: "Stop async display recording",
      description:
        "Stop screenrecord with SIGINT, pull the MP4 into artifacts, and return marks with offsets.",
      inputSchema: {
        serial: serialSchema,
        recordId: z.string().uuid(),
      },
      outputSchema: {
        recordId: z.string(),
        serial: z.string(),
        displayId: z.number(),
        physicalDisplayId: z.string(),
        path: z.string(),
        artifactUri: z.string(),
        sizeBytes: z.number(),
        durationMs: z.number(),
        startedAtIso: z.string(),
        stoppedAtIso: z.string(),
        marks: z.array(
          z.object({
            label: z.string(),
            offsetMs: z.number(),
            wallClockIso: z.string(),
          }),
        ),
      },
      annotations: { ...mutationAnnotations, openWorldHint: true },
    },
    async ({ serial, recordId }, extra) => {
      const result = {
        ...(await recordings.stop(serial, recordId, extra.signal)),
      };
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_analyze_recording",
    {
      title: "Analyze recording for black/dim frames",
      description:
        "Sample mean grayscale over an MP4 (ffmpeg), detect black/dim runs, and classify OEM-agnostic brightness buckets (true_black, near_black_content, system_launcher_idle, dark_app_ui, light_app_ui). Bucket ranges are heuristics—calibrate with exportSampleFrames on the device under test. Use mode='flash' for one-call regressions. Full per-frame timeline is omitted unless includeFullTimeline=true.",
      inputSchema: {
        serial: serialSchema.optional(),
        path: z.string().min(1).optional(),
        artifactUri: z.string().min(1).optional(),
        mode: z
          .enum(["default", "flash"])
          .default("default")
          .describe(
            "flash: exportSampleFrames=true, timelineDownsampleMs=100, blackThreshold=16",
          ),
        fps: z.number().int().min(1).max(60).default(30),
        blackThreshold: z
          .number()
          .min(0)
          .max(255)
          .default(16)
          .describe(
            "Mean gray below this counts as black (default 16 = true_black)",
          ),
        dimThreshold: z.number().min(0).max(255).default(80),
        exportSampleFrames: z.boolean().optional(),
        includeFullTimeline: z.boolean().default(false),
        timelineDownsampleMs: z.number().int().min(50).max(5_000).optional(),
        marks: z
          .array(
            z.object({
              label: z.string(),
              offsetMs: z.number(),
              wallClockIso: z.string().optional(),
            }),
          )
          .optional(),
      },
      outputSchema: {
        path: z.string(),
        durationMs: z.number(),
        width: z.number(),
        height: z.number(),
        frameCount: z.number(),
        sampleFps: z.number(),
        blackThreshold: z.number(),
        dimThreshold: z.number(),
        blackFrameCount: z.number(),
        dimFrameCount: z.number(),
        hasBlackFlash: z.boolean(),
        hasDimFlash: z.boolean(),
        maxBlackRunMs: z.number(),
        maxDimRunMs: z.number(),
        firstBlackOffsetMs: z.number().nullable(),
        lastBlackOffsetMs: z.number().nullable(),
        firstDimOffsetMs: z.number().nullable(),
        lastDimOffsetMs: z.number().nullable(),
        blackRuns: z.array(
          z.object({
            startMs: z.number(),
            endMs: z.number(),
            durationMs: z.number(),
          }),
        ),
        dimRuns: z.array(
          z.object({
            startMs: z.number(),
            endMs: z.number(),
            durationMs: z.number(),
          }),
        ),
        blackRunsTruncated: z.boolean(),
        dimRunsTruncated: z.boolean(),
        timelineSummary: z.array(z.record(z.string(), z.unknown())),
        meanGrayTimeline: z.array(z.record(z.string(), z.unknown())).optional(),
        marks: z.array(z.record(z.string(), z.unknown())),
        samples: z.array(z.record(z.string(), z.unknown())),
        bucketCounts: z.record(z.string(), z.number()),
      },
      annotations: mutationAnnotations,
    },
    async ({
      path,
      artifactUri,
      mode,
      fps,
      blackThreshold,
      dimThreshold,
      exportSampleFrames,
      includeFullTimeline,
      timelineDownsampleMs,
      marks,
    }) => {
      if (!path && !artifactUri) {
        throw new Error("Provide path or artifactUri");
      }
      const resolved = await resolveRecordingPath(
        { path, artifactUri },
        artifacts.root,
      );
      const result = {
        ...(await analyzeRecording(resolved, {
          mode,
          fps,
          blackThreshold,
          dimThreshold,
          ...(exportSampleFrames !== undefined ? { exportSampleFrames } : {}),
          includeFullTimeline,
          ...(timelineDownsampleMs !== undefined
            ? { timelineDownsampleMs }
            : {}),
          marks,
          artifactRoot: artifacts.root,
        })),
      };
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_theme_flash_report",
    {
      title: "Theme / night-mode flash report",
      description:
        "Correlate system night mode with a recording analysis (mode=flash) and marks whose offsets fall inside any reported black/dim run (± markWindowMs).",
      inputSchema: {
        serial: serialSchema,
        path: z.string().min(1).optional(),
        artifactUri: z.string().min(1).optional(),
        markWindowMs: z.number().int().min(50).max(5_000).default(500),
      },
      outputSchema: {
        nightMode: z.string().optional(),
        nightModeRaw: z.string(),
        analysis: z.record(z.string(), z.unknown()),
        marksNearBlack: z.array(z.record(z.string(), z.unknown())),
        marksNearDim: z.array(z.record(z.string(), z.unknown())),
      },
      annotations: mutationAnnotations,
    },
    async ({ serial, path, artifactUri, markWindowMs }, extra) => {
      if (!path && !artifactUri) {
        throw new Error("Provide path or artifactUri");
      }
      await controller.requireDevice(serial, extra.signal);
      const night = await systemOps.getNightMode(serial, extra.signal);
      const resolved = await resolveRecordingPath(
        { path, artifactUri },
        artifacts.root,
      );
      const analysis = await analyzeRecording(resolved, {
        mode: "flash",
        artifactRoot: artifacts.root,
      });
      const marksNearBlack = marksNearRuns(
        analysis.marks,
        analysis.blackRuns,
        markWindowMs,
      );
      const marksNearDim = marksNearRuns(
        analysis.marks,
        analysis.dimRuns,
        markWindowMs,
      );
      const result = {
        ...(night.nightMode ? { nightMode: night.nightMode } : {}),
        nightModeRaw: night.raw,
        analysis: {
          path: analysis.path,
          durationMs: analysis.durationMs,
          blackFrameCount: analysis.blackFrameCount,
          dimFrameCount: analysis.dimFrameCount,
          hasBlackFlash: analysis.hasBlackFlash,
          hasDimFlash: analysis.hasDimFlash,
          maxBlackRunMs: analysis.maxBlackRunMs,
          maxDimRunMs: analysis.maxDimRunMs,
          firstBlackOffsetMs: analysis.firstBlackOffsetMs,
          lastBlackOffsetMs: analysis.lastBlackOffsetMs,
          firstDimOffsetMs: analysis.firstDimOffsetMs,
          lastDimOffsetMs: analysis.lastDimOffsetMs,
          blackRuns: analysis.blackRuns,
          dimRuns: analysis.dimRuns,
          blackRunsTruncated: analysis.blackRunsTruncated,
          dimRunsTruncated: analysis.dimRunsTruncated,
          bucketCounts: analysis.bucketCounts,
          samples: analysis.samples,
          marks: analysis.marks,
        },
        marksNearBlack,
        marksNearDim,
      };
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_focus_trace",
    {
      title: "Trace focused package/activity per display (blocking)",
      description:
        "Blocking sample of focused package/activity/taskId for a fixed duration. Prefer mobile_focus_trace_start/stop when interleaving input or recording. Large sample sets are written to an artifact; only a compact prefix is inlined.",
      inputSchema: {
        serial: serialSchema,
        displayIds: z.array(displayIdSchema).min(1).max(16),
        durationMs: z.number().int().min(100).max(180_000),
        sampleIntervalMs: z
          .number()
          .int()
          .min(50)
          .max(5_000)
          .default(DEFAULT_FOCUS_INTERVAL_MS),
        maxSamples: z
          .number()
          .int()
          .min(10)
          .max(5_000)
          .default(DEFAULT_FOCUS_MAX_SAMPLES),
        includeAllSamples: z.boolean().default(false),
      },
      outputSchema: {
        focusSessionId: z.string(),
        serial: z.string(),
        displayIds: z.array(z.number()),
        durationMs: z.number(),
        sampleIntervalMs: z.number(),
        sampleCount: z.number(),
        truncated: z.boolean(),
        droppedSamples: z.number(),
        startedAtIso: z.string(),
        stoppedAtIso: z.string(),
        changes: z.array(z.record(z.string(), z.unknown())),
        changeCount: z.number(),
        samples: z.array(z.record(z.string(), z.unknown())),
        samplesArtifactUri: z.string().optional(),
        responseCompacted: z.boolean().optional(),
        boundRecordId: z.string().optional(),
      },
      annotations: mutationAnnotations,
    },
    async (
      {
        serial,
        displayIds,
        durationMs,
        sampleIntervalMs,
        maxSamples,
        includeAllSamples,
      },
      extra,
    ) => {
      await controller.requireDevice(serial, extra.signal);
      const stopped = await focusTraces.runFor(
        serial,
        displayIds,
        durationMs,
        sampleIntervalMs,
        extra.signal,
        { maxSamples },
      );
      const result = await compactFocusResult(
        artifacts,
        stopped,
        includeAllSamples,
      );
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_focus_trace_start",
    {
      title: "Start async focus trace",
      description:
        "Start non-blocking focus sampling for logical displays. Optionally bind to a recordId so samples include recordOffsetMs aligned with record marks. Default interval 250ms; samples are ring-buffered (maxSamples).",
      inputSchema: {
        serial: serialSchema,
        displayIds: z.array(displayIdSchema).min(1).max(16),
        sampleIntervalMs: z
          .number()
          .int()
          .min(50)
          .max(5_000)
          .default(DEFAULT_FOCUS_INTERVAL_MS),
        maxSamples: z
          .number()
          .int()
          .min(10)
          .max(5_000)
          .default(DEFAULT_FOCUS_MAX_SAMPLES),
        boundRecordId: z.string().uuid().optional(),
      },
      outputSchema: {
        focusSessionId: z.string(),
        startedAtIso: z.string(),
      },
      annotations: mutationAnnotations,
    },
    async (
      { serial, displayIds, sampleIntervalMs, maxSamples, boundRecordId },
      extra,
    ) => {
      await controller.requireDevice(serial, extra.signal);
      const bound = requireBoundRecording(serial, boundRecordId);
      const result = focusTraces.start(serial, displayIds, sampleIntervalMs, {
        maxSamples,
        ...(bound
          ? {
              boundRecordId: bound.recordId,
              recordStartedAtMs: bound.startedAtMs,
            }
          : {}),
      });
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_focus_trace_stop",
    {
      title: "Stop async focus trace",
      description:
        "Stop an async focus session and return focus change events plus samples (wallClockIso, tMs, optional recordOffsetMs). Prefer `changes` for flash/launcher hunting. Large traces write samples JSON to an artifact.",
      inputSchema: {
        serial: serialSchema,
        focusSessionId: z.string().uuid(),
        includeAllSamples: z.boolean().default(false),
      },
      outputSchema: {
        focusSessionId: z.string(),
        serial: z.string(),
        displayIds: z.array(z.number()),
        durationMs: z.number(),
        sampleIntervalMs: z.number(),
        sampleCount: z.number(),
        truncated: z.boolean(),
        droppedSamples: z.number(),
        startedAtIso: z.string(),
        stoppedAtIso: z.string(),
        changes: z.array(z.record(z.string(), z.unknown())),
        changeCount: z.number(),
        samples: z.array(z.record(z.string(), z.unknown())),
        samplesArtifactUri: z.string().optional(),
        responseCompacted: z.boolean().optional(),
        boundRecordId: z.string().optional(),
      },
      annotations: mutationAnnotations,
    },
    async ({ serial, focusSessionId, includeAllSamples }) => {
      const stopped = await focusTraces.stop(serial, focusSessionId);
      const result = await compactFocusResult(
        artifacts,
        stopped,
        includeAllSamples,
      );
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_artifacts_list",
    {
      title: "List local artifacts",
      description:
        "List metadata stubs (uri, name, mime, size) for files under the artifact root. Does not embed binary contents.",
      inputSchema: {
        limit: z.number().int().min(1).max(5_000).default(200),
      },
      outputSchema: {
        artifactRoot: z.string(),
        count: z.number(),
        artifacts: z.array(
          z.object({
            name: z.string(),
            uri: z.string(),
            mimeType: z.string(),
            sizeBytes: z.number(),
            modifiedAt: z.string(),
          }),
        ),
      },
      annotations: readAnnotations,
    },
    async ({ limit }) => {
      const listed = await artifacts.list(limit);
      const result = {
        artifactRoot: artifacts.root,
        count: listed.length,
        artifacts: listed,
      };
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_artifacts_prune",
    {
      title: "Prune local artifacts",
      description:
        "Delete old or excess artifact files by maxAgeMs and/or maxCount. Use dryRun to preview.",
      inputSchema: {
        maxAgeMs: z.number().int().min(0).optional(),
        maxCount: z.number().int().min(0).max(5_000).optional(),
        dryRun: z.boolean().default(true),
      },
      outputSchema: {
        deleted: z.array(z.string()),
        retained: z.number(),
        dryRun: z.boolean(),
      },
      annotations: { ...mutationAnnotations, destructiveHint: true },
    },
    async ({ maxAgeMs, maxCount, dryRun }) => {
      if (maxAgeMs === undefined && maxCount === undefined) {
        throw new Error("Provide maxAgeMs and/or maxCount");
      }
      const result = {
        ...(await artifacts.prune({ maxAgeMs, maxCount, dryRun })),
      };
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_screen_capture_pair",
    {
      title: "Capture paired Android displays",
      description:
        "Capture multiple logical displays as tightly paired same-moment screenshots (parallel screencap after one display resolve).",
      inputSchema: {
        serial: serialSchema,
        displayIds: z.array(displayIdSchema).min(2).max(8),
        saveArtifact: z.boolean().default(false),
      },
      outputSchema: {
        serial: z.string(),
        skewMs: z.number(),
        captures: z.array(
          z.object({
            displayId: z.number(),
            mimeType: z.literal("image/png"),
            sizeBytes: z.number(),
            durationMs: z.number(),
            artifactUri: z.string().optional(),
          }),
        ),
      },
      annotations: mutationAnnotations,
    },
    async ({ serial, displayIds, saveArtifact }, extra) => {
      const pair = await controller.captureScreenPair(
        serial,
        displayIds,
        extra.signal,
      );
      const captures = [];
      const content: Array<
        | { type: "image"; data: string; mimeType: "image/png" }
        | { type: "text"; text: string }
      > = [];
      for (const capture of pair.captures) {
        const artifact = saveArtifact
          ? await artifacts.save(
              capture.png,
              ".png",
              `display-${capture.displayId}`,
            )
          : undefined;
        captures.push({
          displayId: capture.displayId,
          mimeType: "image/png" as const,
          sizeBytes: capture.png.length,
          durationMs: capture.durationMs,
          ...(artifact ? { artifactUri: artifact.uri } : {}),
        });
        content.push({
          type: "image",
          data: capture.png.toString("base64"),
          mimeType: "image/png",
        });
      }
      const metadata = {
        serial: pair.serial,
        skewMs: pair.skewMs,
        captures,
      };
      content.push(...jsonContent(metadata));
      return { content, structuredContent: metadata };
    },
  );

  server.registerTool(
    "mobile_ui_snapshot",
    {
      title: "Snapshot Android UI",
      description:
        "Return parsed accessibility nodes. Portable ADB supports only display 0; other displays require the companion.",
      inputSchema: { serial: serialSchema, displayId: displayIdSchema },
      outputSchema: {
        serial: z.string(),
        displayId: z.number(),
        backend: z.string(),
        nodes: z.array(z.record(z.string(), z.unknown())),
        truncated: z.boolean(),
      },
      annotations: readAnnotations,
    },
    async ({ serial, displayId }, extra) => {
      const xml = await controller.uiSnapshot(serial, displayId, extra.signal);
      const allNodes = parseUiNodes(xml);
      const result = {
        serial,
        displayId,
        backend: "adb-uiautomator",
        nodes: allNodes.slice(0, 500),
        truncated: allNodes.length > 500,
      };
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  const findInput = {
    serial: serialSchema,
    displayId: displayIdSchema,
    text: z.string().optional(),
    contentDescription: z.string().optional(),
    resourceId: z.string().optional(),
    exact: z.boolean().default(false),
  };

  server.registerTool(
    "mobile_ui_find",
    {
      title: "Find Android UI nodes",
      description:
        "Find accessibility nodes by text, content description, or resource ID.",
      inputSchema: findInput,
      outputSchema: {
        matches: z.array(z.record(z.string(), z.unknown())),
        count: z.number(),
      },
      annotations: readAnnotations,
    },
    async ({ serial, displayId, ...query }, extra) => {
      const xml = await controller.uiSnapshot(serial, displayId, extra.signal);
      const matches = findUiNodes(parseUiNodes(xml), query);
      const result = { matches: matches.slice(0, 100), count: matches.length };
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_ui_wait",
    {
      title: "Wait for Android UI",
      description:
        "Poll until a matching accessibility node appears or the bounded timeout expires.",
      inputSchema: {
        ...findInput,
        timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
        pollMs: z.number().int().min(100).max(5_000).default(500),
      },
      outputSchema: {
        found: z.boolean(),
        attempts: z.number(),
        elapsedMs: z.number(),
        matches: z.array(z.record(z.string(), z.unknown())),
      },
      annotations: readAnnotations,
    },
    async ({ serial, displayId, timeoutMs, pollMs, ...query }, extra) => {
      const started = performance.now();
      let attempts = 0;
      while (performance.now() - started < timeoutMs) {
        attempts += 1;
        const xml = await controller.uiSnapshot(
          serial,
          displayId,
          extra.signal,
        );
        const matches = findUiNodes(parseUiNodes(xml), query);
        if (matches.length > 0) {
          const result = {
            found: true,
            attempts,
            elapsedMs: Math.round(performance.now() - started),
            matches: matches.slice(0, 100),
          };
          return { content: jsonContent(result), structuredContent: result };
        }
        await abortableDelay(pollMs, extra.signal);
      }
      const result = {
        found: false,
        attempts,
        elapsedMs: Math.round(performance.now() - started),
        matches: [],
      };
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_input_tap",
    {
      title: "Tap Android display",
      description:
        "Inject a display-targeted touchscreen tap in logical display coordinates.",
      inputSchema: {
        serial: serialSchema,
        displayId: displayIdSchema,
        ...pointSchema.shape,
      },
      outputSchema: envelopeOutputSchema.shape,
      annotations: mutationAnnotations,
    },
    async ({ serial, displayId, x, y }, extra) => {
      const result = await controller.tap(
        serial,
        displayId,
        x,
        y,
        extra.signal,
      );
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_input_swipe",
    {
      title: "Swipe Android display",
      description:
        "Inject a display-targeted touchscreen swipe with explicit duration.",
      inputSchema: {
        serial: serialSchema,
        displayId: displayIdSchema,
        start: pointSchema,
        end: pointSchema,
        durationMs: z.number().int().min(1).max(60_000).default(300),
      },
      outputSchema: envelopeOutputSchema.shape,
      annotations: mutationAnnotations,
    },
    async ({ serial, displayId, start, end, durationMs }, extra) => {
      const result = await controller.swipe(
        serial,
        displayId,
        start,
        end,
        durationMs,
        extra.signal,
      );
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_input_drag",
    {
      title: "Drag on Android display",
      description:
        "Inject a capability-gated long-press drag-and-drop on one logical display.",
      inputSchema: {
        serial: serialSchema,
        displayId: displayIdSchema,
        start: pointSchema,
        end: pointSchema,
        durationMs: z.number().int().min(1).max(60_000).default(300),
      },
      outputSchema: envelopeOutputSchema.shape,
      annotations: mutationAnnotations,
    },
    async ({ serial, displayId, start, end, durationMs }, extra) => {
      const result = await controller.dragAndDrop(
        serial,
        displayId,
        start,
        end,
        durationMs,
        extra.signal,
      );
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_input_key_combination",
    {
      title: "Send simultaneous Android keys",
      description:
        "Inject a device-supported key combination with explicit ordering and chord duration.",
      inputSchema: {
        serial: serialSchema,
        displayId: displayIdSchema,
        keys: z.array(z.string().min(1)).min(2).max(8),
        durationMs: z.number().int().min(0).max(60_000).default(0),
        source: z.enum(["keyboard", "dpad", "gamepad"]).default("gamepad"),
      },
      outputSchema: envelopeOutputSchema.shape,
      annotations: mutationAnnotations,
    },
    async ({ serial, displayId, keys, durationMs, source }, extra) => {
      const result = await controller.inputKeyCombination(
        serial,
        displayId,
        keys,
        durationMs,
        source,
        extra.signal,
      );
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_input_key",
    {
      title: "Send Android key",
      description:
        "Send symbolic or numeric Android keys with gamepad source and capability-gated press options.",
      inputSchema: {
        serial: serialSchema,
        displayId: displayIdSchema,
        key: z.string().min(1),
        source: z.enum(["keyboard", "dpad", "gamepad"]).default("gamepad"),
        action: z.enum(["press", "long_press", "double_tap"]).default("press"),
        durationMs: z.number().int().min(1).max(60_000).optional(),
      },
      outputSchema: envelopeOutputSchema.shape,
      annotations: mutationAnnotations,
    },
    async ({ serial, ...input }, extra) => {
      const result = await controller.inputKey(serial, input, extra.signal);
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_input_text",
    {
      title: "Type Android text",
      description:
        "Type text through ADB's virtual keyboard. Reports the Unicode limitation instead of hiding it.",
      inputSchema: {
        serial: serialSchema,
        displayId: displayIdSchema,
        text: z.string().max(10_000),
      },
      outputSchema: envelopeOutputSchema.shape,
      annotations: mutationAnnotations,
    },
    async ({ serial, displayId, text }, extra) => {
      const result = await controller.inputText(
        serial,
        displayId,
        text,
        extra.signal,
      );
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_app_inspect",
    {
      title: "Inspect Android app",
      description:
        "Read package state, permissions, components, users, and installation metadata.",
      inputSchema: {
        serial: serialSchema,
        packageName: packageSchema,
      },
      outputSchema: { packageName: z.string(), dump: z.string() },
      annotations: readAnnotations,
    },
    async ({ serial, packageName }, extra) => {
      const result = {
        packageName,
        dump: await controller.inspectApp(serial, packageName, extra.signal),
      };
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_app_launch",
    {
      title: "Launch Android app",
      description:
        "Resolve and launch an activity on a logical display with ActivityManager wait diagnostics.",
      inputSchema: {
        serial: serialSchema,
        packageName: packageSchema,
        displayId: displayIdSchema,
        activity: z.string().optional(),
        userId: z
          .union([z.literal("current"), z.number().int().nonnegative()])
          .default("current"),
      },
      outputSchema: envelopeOutputSchema.shape,
      annotations: mutationAnnotations,
    },
    async ({ serial, packageName, displayId, activity, userId }, extra) => {
      const result = await controller.launchApp(
        serial,
        packageName,
        displayId,
        activity,
        extra.signal,
        userId,
      );
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_app_stop",
    {
      title: "Force-stop Android app",
      description:
        "Force-stop a package, including its processes and pending implicit launches.",
      inputSchema: {
        serial: serialSchema,
        packageName: packageSchema,
        userId: z
          .union([z.literal("current"), z.number().int().nonnegative()])
          .default("current"),
      },
      outputSchema: envelopeOutputSchema.shape,
      annotations: { ...mutationAnnotations, idempotentHint: true },
    },
    async ({ serial, packageName, userId }, extra) => {
      const result = await controller.stopApp(
        serial,
        packageName,
        userId,
        extra.signal,
      );
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_app_relaunch_on_displays",
    {
      title: "Stop then launch on displays",
      description:
        "Force-stop a package, then launch its main (or given) activity on each logical display in order. Use for dual-display cold-start / flash reproduction.",
      inputSchema: {
        serial: serialSchema,
        packageName: packageSchema,
        displayIds: z.array(displayIdSchema).min(1).max(16),
        activity: z.string().optional(),
        settleMs: z.number().int().min(0).max(10_000).default(300),
        userId: z
          .union([z.literal("current"), z.number().int().nonnegative()])
          .default("current"),
      },
      outputSchema: {
        packageName: z.string(),
        stopped: z.record(z.string(), z.unknown()),
        launches: z.array(z.record(z.string(), z.unknown())),
      },
      annotations: mutationAnnotations,
    },
    async (
      { serial, packageName, displayIds, activity, settleMs, userId },
      extra,
    ) => {
      const stopped = await controller.stopApp(
        serial,
        packageName,
        userId,
        extra.signal,
      );
      if (settleMs > 0) await abortableDelay(settleMs, extra.signal);
      const launches = [];
      for (const displayId of displayIds) {
        launches.push(
          await controller.launchApp(
            serial,
            packageName,
            displayId,
            activity,
            extra.signal,
            userId,
          ),
        );
        if (settleMs > 0) await abortableDelay(settleMs, extra.signal);
      }
      const result = { packageName, stopped, launches };
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_app_install",
    {
      title: "Install Android APK",
      description:
        "Install one local APK with a bounded timeout and structured ADB result.",
      inputSchema: {
        serial: serialSchema,
        path: z.string().min(1),
        replace: z.boolean().default(true),
      },
      outputSchema: envelopeOutputSchema.shape,
      annotations: { ...mutationAnnotations, openWorldHint: true },
    },
    async ({ serial, path, replace }, extra) => {
      const result = await controller.installApp(
        serial,
        path,
        replace,
        extra.signal,
      );
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_app_uninstall",
    {
      title: "Uninstall Android app",
      description: "Uninstall a package, optionally retaining its data.",
      inputSchema: {
        serial: serialSchema,
        packageName: packageSchema,
        keepData: z.boolean().default(false),
      },
      outputSchema: envelopeOutputSchema.shape,
      annotations: { ...mutationAnnotations, destructiveHint: true },
    },
    async ({ serial, packageName, keepData }, extra) => {
      const result = await controller.uninstallApp(
        serial,
        packageName,
        keepData,
        extra.signal,
      );
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  if (profiles.has("diagnostics") || profiles.has("all")) {
    server.registerTool(
      "mobile_diagnostics_collect",
      {
        title: "Collect Android diagnostics",
        description:
          "Collect bounded, typed dumpsys sections for display, activity, input, power, memory, and CPU diagnosis.",
        inputSchema: {
          serial: serialSchema,
          sections: z
            .array(
              z.enum([
                "activity",
                "window",
                "display",
                "input",
                "power",
                "battery",
                "meminfo",
                "cpuinfo",
              ]),
            )
            .min(1),
          packageName: packageSchema.optional(),
        },
        outputSchema: { sections: z.record(z.string(), z.string()) },
        annotations: readAnnotations,
      },
      async ({ serial, sections, packageName }, extra) => {
        const result = {
          sections: await controller.collectDiagnostics(
            serial,
            sections,
            packageName,
            extra.signal,
          ),
        };
        return { content: jsonContent(result), structuredContent: result };
      },
    );

    server.registerTool(
      "mobile_logcat",
      {
        title: "Read bounded Android logs",
        description:
          "Read a bounded logcat snapshot with validated buffer, tags, priority, and line count.",
        inputSchema: {
          serial: serialSchema,
          buffer: z
            .enum(["main", "system", "crash", "events", "radio"])
            .default("main"),
          lines: z.number().int().min(1).max(10_000).default(500),
          tags: z.array(z.string()).max(50).default([]),
          minimumPriority: z.enum(["V", "D", "I", "W", "E", "F"]).default("I"),
        },
        outputSchema: { log: z.string() },
        annotations: readAnnotations,
      },
      async ({ serial, buffer, lines, tags, minimumPriority }, extra) => {
        await controller.requireDevice(serial, extra.signal);
        const result = {
          log: await adbProfiles.logcat(
            serial,
            { buffer, lines, tags, minimumPriority },
            extra.signal,
          ),
        };
        return { content: jsonContent(result), structuredContent: result };
      },
    );

    server.registerTool(
      "mobile_logcat_start",
      {
        title: "Start scoped logcat session",
        description:
          "Start a streaming logcat capture cleared to now. Optionally bind to a recordId and filter by tags/packages.",
        inputSchema: {
          serial: serialSchema,
          tags: z.array(z.string()).max(50).default([]),
          packages: z.array(packageSchema).max(20).default([]),
          buffer: z
            .enum(["main", "system", "crash", "events", "radio"])
            .default("main"),
          minimumPriority: z.enum(["V", "D", "I", "W", "E", "F"]).default("I"),
          boundRecordId: z.string().uuid().optional(),
        },
        outputSchema: {
          logSessionId: z.string(),
          pathHint: z.string(),
          startedAtIso: z.string(),
        },
        annotations: { ...mutationAnnotations, openWorldHint: true },
      },
      async (
        { serial, tags, packages, buffer, minimumPriority, boundRecordId },
        extra,
      ) => {
        await controller.requireDevice(serial, extra.signal);
        const bound = requireBoundRecording(serial, boundRecordId);
        const result = await logcats.start(
          serial,
          { tags, packages, buffer, minimumPriority },
          { boundRecordId: bound?.recordId },
        );
        return { content: jsonContent(result), structuredContent: result };
      },
    );

    server.registerTool(
      "mobile_logcat_stop",
      {
        title: "Stop scoped logcat session",
        description:
          "Stop a streaming logcat session and return the captured lines (optionally package-filtered).",
        inputSchema: {
          serial: serialSchema,
          logSessionId: z.string().uuid(),
          maxLines: z.number().int().min(1).max(20_000).default(2_000),
        },
        outputSchema: {
          logSessionId: z.string(),
          serial: z.string(),
          path: z.string(),
          artifactUri: z.string(),
          sizeBytes: z.number(),
          durationMs: z.number(),
          startedAtIso: z.string(),
          stoppedAtIso: z.string(),
          lines: z.array(z.string()),
          lineCount: z.number(),
          truncated: z.boolean(),
          boundRecordId: z.string().optional(),
        },
        annotations: mutationAnnotations,
      },
      async ({ serial, logSessionId, maxLines }) => {
        const result = {
          ...(await logcats.stop(serial, logSessionId, { maxLines })),
        };
        return { content: jsonContent(result), structuredContent: result };
      },
    );

    server.registerTool(
      "mobile_diagnostics_activity_tops",
      {
        title: "Dump activity tops",
        description:
          "Return structured focused/resumed activities (package, activity, displayId, taskId) plus byDisplayId grouping from dumpsys activity activities.",
        inputSchema: { serial: serialSchema },
        outputSchema: {
          tops: z.array(z.record(z.string(), z.unknown())),
          byDisplayId: z.record(
            z.string(),
            z.array(z.record(z.string(), z.unknown())),
          ),
          raw: z.string(),
        },
        annotations: readAnnotations,
      },
      async ({ serial }, extra) => {
        await controller.requireDevice(serial, extra.signal);
        const result = {
          ...(await systemOps.activityTops(serial, extra.signal)),
        };
        return { content: jsonContent(result), structuredContent: result };
      },
    );

    server.registerTool(
      "mobile_diagnostics_layer_hints",
      {
        title: "SurfaceFlinger layer hints",
        description:
          "Return bounded SurfaceFlinger lines that may indicate HWC/Presentation/layer ownership issues related to blank panels.",
        inputSchema: { serial: serialSchema },
        outputSchema: {
          hints: z.array(z.string()),
          raw: z.string(),
        },
        annotations: readAnnotations,
      },
      async ({ serial }, extra) => {
        await controller.requireDevice(serial, extra.signal);
        const result = {
          ...(await systemOps.layerHints(serial, extra.signal)),
        };
        return { content: jsonContent(result), structuredContent: result };
      },
    );

    server.registerTool(
      "mobile_power_wake",
      {
        title: "Wake device",
        description: "Send KEYCODE_WAKEUP to turn the screen on.",
        inputSchema: { serial: serialSchema },
        outputSchema: { ok: z.literal(true), output: z.string() },
        annotations: mutationAnnotations,
      },
      async ({ serial }, extra) => {
        await controller.requireDevice(serial, extra.signal);
        const output = await systemOps.wake(serial, extra.signal);
        const result = { ok: true as const, output };
        return { content: jsonContent(result), structuredContent: result };
      },
    );

    server.registerTool(
      "mobile_uimode_get",
      {
        title: "Get night mode",
        description: "Read the current ui mode night setting via cmd uimode.",
        inputSchema: { serial: serialSchema },
        outputSchema: {
          raw: z.string(),
          nightMode: z.string().optional(),
        },
        annotations: readAnnotations,
      },
      async ({ serial }, extra) => {
        await controller.requireDevice(serial, extra.signal);
        const result = {
          ...(await systemOps.getNightMode(serial, extra.signal)),
        };
        return { content: jsonContent(result), structuredContent: result };
      },
    );

    server.registerTool(
      "mobile_uimode_set",
      {
        title: "Set night mode",
        description:
          "Set night mode via cmd uimode night (yes/no/auto/custom_*). Useful when theme/splash flashes depend on system night mode.",
        inputSchema: {
          serial: serialSchema,
          mode: z.enum([
            "yes",
            "no",
            "auto",
            "custom_schedule",
            "custom_bedtime",
          ]),
        },
        outputSchema: { output: z.string() },
        annotations: mutationAnnotations,
      },
      async ({ serial, mode }, extra) => {
        await controller.requireDevice(serial, extra.signal);
        const result = {
          output: await systemOps.setNightMode(serial, mode, extra.signal),
        };
        return { content: jsonContent(result), structuredContent: result };
      },
    );

    server.registerTool(
      "mobile_app_prefs_read",
      {
        title: "Read debuggable app shared_prefs",
        description:
          "Read a shared_prefs XML file via run-as (debuggable apps only).",
        inputSchema: {
          serial: serialSchema,
          packageName: packageSchema,
          fileName: z
            .string()
            .regex(/^[A-Za-z0-9_./-]{1,128}$/)
            .describe("File under shared_prefs/, e.g. settings.xml"),
        },
        outputSchema: { xml: z.string() },
        annotations: readAnnotations,
      },
      async ({ serial, packageName, fileName }, extra) => {
        await controller.requireDevice(serial, extra.signal);
        const result = {
          xml: await systemOps.readSharedPrefs(
            serial,
            packageName,
            fileName,
            extra.signal,
          ),
        };
        return { content: jsonContent(result), structuredContent: result };
      },
    );
  }

  if (profiles.has("apps") || profiles.has("all")) {
    server.registerTool(
      "mobile_packages_list",
      {
        title: "List Android packages",
        description:
          "List packages for an explicit Android user with stable package-manager filters.",
        inputSchema: {
          serial: serialSchema,
          userId: z.number().int().nonnegative().default(0),
          thirdPartyOnly: z.boolean().default(false),
          includeDisabled: z.boolean().default(false),
        },
        outputSchema: { packages: z.array(z.string()) },
        annotations: readAnnotations,
      },
      async ({ serial, userId, thirdPartyOnly, includeDisabled }, extra) => {
        await controller.requireDevice(serial, extra.signal);
        const result = {
          packages: await adbProfiles.listPackages(
            serial,
            { userId, thirdPartyOnly, includeDisabled },
            extra.signal,
          ),
        };
        return { content: jsonContent(result), structuredContent: result };
      },
    );

    server.registerTool(
      "mobile_broadcast_send",
      {
        title: "Send Android broadcast",
        description:
          "Send a validated broadcast with optional package scope, explicit user, and string extras.",
        inputSchema: {
          serial: serialSchema,
          action: z.string().min(1),
          packageName: packageSchema.optional(),
          userId: z.number().int().nonnegative().default(0),
          extras: z.record(z.string(), z.string()).default({}),
        },
        outputSchema: { output: z.string() },
        annotations: mutationAnnotations,
      },
      async ({ serial, action, packageName, userId, extras }, extra) => {
        await controller.requireDevice(serial, extra.signal);
        const result = {
          output: await adbProfiles.sendBroadcast(
            serial,
            { action, packageName, userId, extras },
            extra.signal,
          ),
        };
        return { content: jsonContent(result), structuredContent: result };
      },
    );
  }

  if (profiles.has("files") || profiles.has("all")) {
    server.registerTool(
      "mobile_file_push",
      {
        title: "Push file to Android",
        description:
          "Push a file from the configured host root to approved shared-storage or temporary device roots.",
        inputSchema: {
          serial: serialSchema,
          localPath: z.string().min(1),
          remotePath: z.string().min(1),
        },
        outputSchema: { output: z.string() },
        annotations: { ...mutationAnnotations, openWorldHint: true },
      },
      async ({ serial, localPath, remotePath }, extra) => {
        await controller.requireDevice(serial, extra.signal);
        const result = {
          output: await adbProfiles.push(
            serial,
            localPath,
            remotePath,
            extra.signal,
          ),
        };
        return { content: jsonContent(result), structuredContent: result };
      },
    );

    server.registerTool(
      "mobile_file_pull",
      {
        title: "Pull Android artifact",
        description:
          "Pull from approved device roots into the server-managed artifact directory.",
        inputSchema: { serial: serialSchema, remotePath: z.string().min(1) },
        outputSchema: {
          path: z.string(),
          artifactUri: z.string(),
          output: z.string(),
        },
        annotations: { ...mutationAnnotations, openWorldHint: true },
      },
      async ({ serial, remotePath }, extra) => {
        await controller.requireDevice(serial, extra.signal);
        const result = await adbProfiles.pull(serial, remotePath, extra.signal);
        return { content: jsonContent(result), structuredContent: result };
      },
    );
  }

  if (profiles.has("performance") || profiles.has("all")) {
    server.registerTool(
      "mobile_performance_snapshot",
      {
        title: "Collect Android performance snapshot",
        description:
          "Collect bounded CPU, power, battery, and optional package memory/frame diagnostics.",
        inputSchema: {
          serial: serialSchema,
          packageName: packageSchema.optional(),
        },
        outputSchema: { sections: z.record(z.string(), z.string()) },
        annotations: readAnnotations,
      },
      async ({ serial, packageName }, extra) => {
        await controller.requireDevice(serial, extra.signal);
        const result = {
          sections: await adbProfiles.performance(
            serial,
            packageName,
            extra.signal,
          ),
        };
        return { content: jsonContent(result), structuredContent: result };
      },
    );
  }

  if (profiles.has("device-admin") || profiles.has("all")) {
    server.registerTool(
      "mobile_permission_set",
      {
        title: "Set Android runtime permission",
        description:
          "Grant or revoke one named runtime permission for an explicit package and user.",
        inputSchema: {
          serial: serialSchema,
          action: z.enum(["grant", "revoke"]),
          packageName: packageSchema,
          permission: z.string().min(1),
          userId: z.number().int().nonnegative().default(0),
        },
        outputSchema: { changed: z.literal(true) },
        annotations: { ...mutationAnnotations, destructiveHint: true },
      },
      async ({ serial, action, packageName, permission, userId }, extra) => {
        await controller.requireDevice(serial, extra.signal);
        await adbProfiles.permission(
          serial,
          { action, packageName, permission, userId },
          extra.signal,
        );
        const result = { changed: true as const };
        return { content: jsonContent(result), structuredContent: result };
      },
    );
  }

  if (profiles.has("companion") || profiles.has("all")) {
    server.registerTool(
      "mobile_companion_install",
      {
        title: "Install advanced-input companion",
        description:
          "Install the companion target and instrumentation APKs used for explicit key lifecycle and all-display windows.",
        inputSchema: {
          serial: serialSchema,
          appApk: z.string().min(1),
          testApk: z.string().min(1),
        },
        outputSchema: { installed: z.literal(true) },
        annotations: { ...mutationAnnotations, openWorldHint: true },
      },
      async ({ serial, appApk, testApk }, extra) => {
        await controller.requireDevice(serial, extra.signal);
        await companion.install(serial, appApk, testApk, extra.signal);
        const result = { installed: true as const };
        return { content: jsonContent(result), structuredContent: result };
      },
    );

    server.registerTool(
      "mobile_companion_start",
      {
        title: "Start advanced-input companion",
        description:
          "Start an authenticated UiAutomation instrumentation session through an owned ADB forward.",
        inputSchema: { serial: serialSchema },
        outputSchema: { session: z.record(z.string(), z.unknown()) },
        annotations: mutationAnnotations,
      },
      async ({ serial }, extra) => {
        await controller.requireDevice(serial, extra.signal);
        const result = { session: await companion.start(serial, extra.signal) };
        return { content: jsonContent(result), structuredContent: result };
      },
    );

    server.registerTool(
      "mobile_companion_key",
      {
        title: "Send advanced Android key event",
        description:
          "Inject explicit press/down/up events with preserved downTime through UiAutomation; keys follow focused-display policy.",
        inputSchema: {
          serial: serialSchema,
          keyCode: z.number().int().min(0).max(1000),
          action: z.enum(["press", "down", "up"]),
          source: z
            .enum(["keyboard", "dpad", "gamepad", "joystick"])
            .default("gamepad"),
          repeat: z.number().int().min(0).max(1000).default(0),
          metaState: z.number().int().nonnegative().default(0),
        },
        outputSchema: { result: z.record(z.string(), z.unknown()) },
        annotations: mutationAnnotations,
      },
      async ({ serial, keyCode, action, source, repeat, metaState }, extra) => {
        const result = {
          result: await companion.key(
            serial,
            keyCode,
            action,
            source,
            repeat,
            metaState,
            extra.signal,
          ),
        };
        return { content: jsonContent(result), structuredContent: result };
      },
    );

    server.registerTool(
      "mobile_companion_windows",
      {
        title: "List windows on all displays",
        description:
          "Read UiAutomation interactive windows grouped by logical display from the active companion.",
        inputSchema: { serial: serialSchema },
        outputSchema: { result: z.record(z.string(), z.unknown()) },
        annotations: readAnnotations,
      },
      async ({ serial }, extra) => {
        const result = {
          result: await companion.windows(serial, extra.signal),
        };
        return { content: jsonContent(result), structuredContent: result };
      },
    );

    server.registerTool(
      "mobile_companion_stop",
      {
        title: "Stop advanced-input companion",
        description:
          "Release every held key, stop instrumentation, and remove the session-owned ADB forward.",
        inputSchema: { serial: serialSchema },
        outputSchema: { stopped: z.literal(true) },
        annotations: { ...mutationAnnotations, idempotentHint: true },
      },
      async ({ serial }) => {
        await companion.stop(serial);
        const result = { stopped: true as const };
        return { content: jsonContent(result), structuredContent: result };
      },
    );
  }

  const toolNames = listedTools();
  const missingDetective = CORE_DETECTIVE_TOOLS.filter(
    (name) => !toolNames.includes(name),
  );
  if (missingDetective.length > 0) {
    console.error(
      `[polyscreen-mcp] Tool registration self-check failed: missing=${missingDetective.join(",")}`,
    );
  } else {
    console.error(
      `[polyscreen-mcp] ${PACKAGE_VERSION} registered ${toolNames.length} tools (profiles=${[...profiles].sort().join(",")}): ${toolNames.join(", ")}`,
    );
  }

  server.listRegisteredTools = listedTools;
  server.notifyToolListChanged = () => {
    server.sendToolListChanged();
  };

  const closeServer = server.close.bind(server);
  server.close = async (): Promise<void> => {
    await Promise.allSettled([
      recordings.stopAll(),
      logcats.stopAll(),
      focusTraces.stopAll(),
      companion.stopAll(),
    ]);
    await closeServer();
  };

  return server;
}
