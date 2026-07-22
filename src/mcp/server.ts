import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { AdbProfiles } from "../android/adb-profiles.js";
import { AndroidController } from "../android/android-controller.js";
import { LogcatSessionManager } from "../android/logcat-sessions.js";
import {
  analyzeRecording,
  resolveRecordingPath,
} from "../android/recording-analyze.js";
import { RecordingSessionManager } from "../android/record-sessions.js";
import { findUiNodes, parseUiNodes } from "../android/ui.js";
import { ArtifactStore } from "../artifacts/store.js";
import { CompanionManager } from "../backends/companion.js";
import { abortableDelay } from "../utils/abortable-delay.js";
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
  profiles?: ReadonlySet<string>;
}

const jsonContent = (value: unknown) => [
  { type: "text" as const, text: JSON.stringify(value, null, 2) },
];

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
): McpServer {
  const controller = options.controller ?? new AndroidController();
  const companion = options.companion ?? new CompanionManager(controller.adb);
  const adbProfiles = options.adbProfiles ?? new AdbProfiles(controller.adb);
  const artifacts =
    options.artifacts ?? new ArtifactStore(adbProfiles.artifactRoot);
  const recordings =
    options.recordings ??
    new RecordingSessionManager(controller.adb, adbProfiles.artifactRoot);
  const logcats =
    options.logcats ??
    new LogcatSessionManager(controller.adb, adbProfiles.artifactRoot);
  const profiles = options.profiles ?? new Set(["core"]);
  const server = new McpServer({
    name: "polyscreen-mcp",
    version: "0.3.0",
  });

  server.registerResource(
    "mobile-artifacts",
    new ResourceTemplate("mobile://artifacts/{name}", {
      list: async () => ({
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
        "Screenshots, recordings, logs, traces, and pulled files retained locally.",
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
    "mobile_devices_list",
    {
      title: "List Android devices",
      description:
        "List ADB devices with reachability probes, hardware serial grouping, and preferred TCP serial when duplicates exist.",
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
        marks: z.array(z.object({ label: z.string(), offsetMs: z.number() })),
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
        "Sample mean grayscale over an MP4 (ffmpeg), detect black/dim runs, classify brightness buckets, and optionally export sample PNGs at anomalies and marks.",
      inputSchema: {
        serial: serialSchema.optional(),
        path: z.string().min(1).optional(),
        artifactUri: z.string().min(1).optional(),
        fps: z.number().int().min(1).max(60).default(30),
        blackThreshold: z.number().min(0).max(255).default(40),
        dimThreshold: z.number().min(0).max(255).default(80),
        exportSampleFrames: z.boolean().default(false),
        marks: z
          .array(z.object({ label: z.string(), offsetMs: z.number() }))
          .optional(),
      },
      outputSchema: {
        path: z.string(),
        durationMs: z.number(),
        frameCount: z.number(),
        blackFrameCount: z.number(),
        dimFrameCount: z.number(),
        maxBlackRunMs: z.number(),
        firstBlackOffsetMs: z.number().nullable(),
        lastBlackOffsetMs: z.number().nullable(),
        meanGrayTimeline: z.array(z.record(z.string(), z.unknown())),
        marks: z.array(z.object({ label: z.string(), offsetMs: z.number() })),
        samples: z.array(z.record(z.string(), z.unknown())),
        bucketCounts: z.record(z.string(), z.number()),
      },
      annotations: readAnnotations,
    },
    async ({
      path,
      artifactUri,
      fps,
      blackThreshold,
      dimThreshold,
      exportSampleFrames,
      marks,
    }) => {
      if (!path && !artifactUri) {
        throw new Error("Provide path or artifactUri");
      }
      const resolved = await resolveRecordingPath(
        { path, artifactUri },
        adbProfiles.artifactRoot,
      );
      const result = {
        ...(await analyzeRecording(resolved, {
          fps,
          blackThreshold,
          dimThreshold,
          exportSampleFrames,
          marks,
          artifactRoot: adbProfiles.artifactRoot,
        })),
      };
      return { content: jsonContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "mobile_focus_trace",
    {
      title: "Trace focused package/activity per display",
      description:
        "Sample focused package, activity, and taskId over time for the requested logical displays (alignable with record marks).",
      inputSchema: {
        serial: serialSchema,
        displayIds: z.array(displayIdSchema).min(1).max(16),
        durationMs: z.number().int().min(100).max(180_000),
        sampleIntervalMs: z.number().int().min(50).max(5_000).default(100),
      },
      outputSchema: {
        serial: z.string(),
        displayIds: z.array(z.number()),
        durationMs: z.number(),
        sampleIntervalMs: z.number(),
        sampleCount: z.number(),
        samples: z.array(z.record(z.string(), z.unknown())),
      },
      annotations: readAnnotations,
    },
    async ({ serial, displayIds, durationMs, sampleIntervalMs }, extra) => {
      const result = await controller.focusTrace(
        serial,
        displayIds,
        durationMs,
        sampleIntervalMs,
        extra.signal,
      );
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
      },
      outputSchema: envelopeOutputSchema.shape,
      annotations: mutationAnnotations,
    },
    async ({ serial, packageName, displayId, activity }, extra) => {
      const result = await controller.launchApp(
        serial,
        packageName,
        displayId,
        activity,
        extra.signal,
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
        },
        annotations: { ...mutationAnnotations, openWorldHint: true },
      },
      async (
        { serial, tags, packages, buffer, minimumPriority, boundRecordId },
        extra,
      ) => {
        await controller.requireDevice(serial, extra.signal);
        if (boundRecordId && !recordings.get(boundRecordId)) {
          throw new Error(`Unknown bound recordId: ${boundRecordId}`);
        }
        const result = await logcats.start(
          serial,
          { tags, packages, buffer, minimumPriority },
          { boundRecordId },
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

  const closeServer = server.close.bind(server);
  server.close = async (): Promise<void> => {
    await Promise.allSettled([
      recordings.stopAll(),
      logcats.stopAll(),
      companion.stopAll(),
    ]);
    await closeServer();
  };

  return server;
}
