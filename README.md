# PolyScreen MCP

An Android-first Model Context Protocol server built for reliable automation on real devices, including multi-display handhelds, gamepads, emulators, and test labs.

The server uses the official `adb` executable for its portable core. It probes each connected device at runtime instead of assuming capabilities from the Android version. Optional tool profiles add diagnostics, app operations, constrained file transfer, performance snapshots, permission control, and an instrumentation companion for explicit key down/up plus accessibility windows on every display.

## Why

Existing mobile MCP servers commonly:

- confuse Android logical display IDs with SurfaceFlinger physical IDs;
- capture one display while injecting input into another;
- expose only a small hard-coded set of physical buttons;
- treat `uiautomator dump` as multi-display aware when it is not;
- return prose that agents must parse;
- expose unrestricted shell commands as ordinary tools.

PolyScreen MCP keeps those boundaries explicit and returns structured evidence for every operation.

## Requirements

- Node.js 22.12 or newer
- pnpm 11
- Android platform tools with `adb` on `PATH`, or `ADB_PATH=/absolute/path/to/adb`
- Android 11 or newer for the supported multi-display baseline
- `ffmpeg` and `ffprobe` on `PATH` for `mobile_analyze_recording`
- JDK 17 and Android SDK only when building the optional companion

## Install and build

```bash
pnpm install
pnpm check
pnpm build
```

Run through an MCP client:

```json
{
  "mcpServers": {
    "polyscreen": {
      "command": "node",
      "args": [
        "/absolute/path/to/polyscreen-mcp/dist/cli.js",
        "--profile",
        "core",
        "diagnostics",
        "companion"
      ]
    }
  }
}
```

After publication, the intended command is:

```json
{
  "mcpServers": {
    "polyscreen": {
      "command": "npx",
      "args": ["-y", "polyscreen-mcp@latest"]
    }
  }
}
```

For local Streamable HTTP:

```bash
polyscreen-mcp --listen 3300 --token "replace-with-a-secret"
```

The endpoint is `http://127.0.0.1:3300/mcp`. HTTP always binds to loopback, validates `Host` and `Origin`, and optionally requires the configured bearer token. Stdio remains the default.

## Tool profiles

The default `core` profile is deliberately compact. Additional profiles advertise tools only when requested.

| Profile        | Capabilities                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `core`         | Devices, capabilities, displays, screenshots, async record/analyze, focus traces, UI, touch, keys, text, app lifecycle/install |
| `apps`         | Package inventory and scoped broadcasts                                                                                        |
| `diagnostics`  | Bounded dumpsys bundles, filtered logcat snapshots, and scoped logcat start/stop sessions                                      |
| `files`        | Constrained push/pull under approved roots                                                                                     |
| `performance`  | CPU, power, battery, memory, and frame snapshots                                                                               |
| `device-admin` | Explicit runtime permission grant/revoke                                                                                       |
| `companion`    | All-display accessibility windows and explicit key press/down/up                                                               |
| `all`          | Every implemented profile                                                                                                      |

`unsafe` and emulator profiles are reserved but do not expose raw shell in this release.

## Core tools

- `mobile_devices_list`
- `mobile_device_inspect`
- `mobile_displays_list`
- `mobile_screen_capture`
- `mobile_screen_capture_pair`
- `mobile_screen_record`
- `mobile_record_start` / `mobile_record_mark` / `mobile_record_stop`
- `mobile_analyze_recording`
- `mobile_focus_trace`
- `mobile_ui_snapshot`
- `mobile_ui_find`
- `mobile_ui_wait`
- `mobile_input_tap`
- `mobile_input_swipe`
- `mobile_input_drag`
- `mobile_input_key`
- `mobile_input_key_combination`
- `mobile_input_text`
- `mobile_app_inspect`
- `mobile_app_launch`
- `mobile_app_stop`
- `mobile_app_install`
- `mobile_app_uninstall`

Every display-sensitive tool takes a framework **logical** `displayId`. Screenshot and recording implementations resolve that to a SurfaceFlinger **physical** ID internally.

Screenshots can be retained with `saveArtifact`. Pulled files and retained captures are exposed through the `mobile://artifacts/{name}` MCP resource template, keeping large binary payloads out of structured JSON.

### Devices and serials

`mobile_devices_list` returns exact ADB serials plus:

- `reachable` — short `get-state` probe (stale wireless/mDNS entries often fail here);
- `hardwareSerial` — `ro.serialno` when the probe succeeds;
- `preferred` / `preferredSerial` — when the same hardware appears under multiple serials (for example TCP `IP:port` and an `adb-tls` mDNS name), the list prefers a reachable TCP serial and points duplicates at it.

Never invent a serial. Pass the exact value from this list into every other tool.

### Async recording and visual analysis

`mobile_screen_record` blocks for its full `durationSeconds`, so the agent cannot send input during capture. Prefer the async session when reproducing launch, Home, or gamepad-driven transitions:

| Tool                       | Purpose                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `mobile_record_start`      | Start on-device `screenrecord` for one logical display. Returns `{ recordId, pathHint }`. One active session per `(serial, displayId)`. |
| `mobile_record_mark`       | Label a timeline point (`pre-launch`, `press-a`, `home`, …) with `offsetMs` from session start.                                         |
| `mobile_record_stop`       | SIGINT the recorder, pull the MP4 into artifacts, return `{ path, artifactUri, marks, durationMs }`.                                    |
| `mobile_analyze_recording` | Quantify black/dim frames from a local `path` or `mobile://artifacts/…` URI.                                                            |

Async sessions run in the background on the device and do **not** hold the per-device mutation queue, so `mobile_input_key`, taps, and other tools can interleave freely.

`mobile_analyze_recording` options:

| Option               | Default        | Meaning                                                    |
| -------------------- | -------------- | ---------------------------------------------------------- |
| `fps`                | `30`           | Sample rate for the mean-gray timeline                     |
| `blackThreshold`     | `40`           | Frame mean gray below this counts as black                 |
| `dimThreshold`       | `80`           | Frame mean gray below this counts as dim                   |
| `exportSampleFrames` | `false`        | Write PNGs at first/last black and at each mark            |
| `marks`              | sidecar / none | Optional explicit marks if no `.marks.json` sidecar exists |

Analysis requires host `ffmpeg` and `ffprobe`. Typical structured fields:

- `durationMs`, `frameCount`, `blackFrameCount`, `dimFrameCount`
- `maxBlackRunMs`, `firstBlackOffsetMs`, `lastBlackOffsetMs`
- `meanGrayTimeline` — `[{ tMs, mean, bucket }, …]`
- `marks`, `samples` (exported frame paths when requested)
- `bucketCounts` — coarse brightness classifiers:
  - `true_black` — near-empty / HWC black (very low mean)
  - `system_launcher_idle` — mid-dark idle wallpaper/launcher band
  - `dark_app_ui` — dark theme / splash-like content
  - `light_app_ui` — bright light-theme UI
  - `other` — everything else

Thresholds alone cannot separate true black from dark UI; use `exportSampleFrames` when classifying regressions.

### Focus timeline

`mobile_focus_trace` samples focused package, activity, task id, and window for the requested logical displays over `durationMs` at `sampleIntervalMs` (default 100 ms). Timestamps are wall-clock offsets alignable with record marks. Use this when a screenshot cannot show whether the system launcher briefly owned a display before an app reclaimed it.

### Paired capture

`mobile_screen_capture_pair` resolves displays once, then runs parallel `screencap` for two or more logical IDs. Useful when a flash appears on one display while another is launching. Returns per-display PNGs plus `skewMs` for the parallel window.

### Scoped logcat (diagnostics profile)

| Tool                  | Purpose                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `mobile_logcat`       | One-shot bounded dump (`-d`) with validated buffer, tags, and priority                            |
| `mobile_logcat_start` | Clear the buffer and stream logs to an artifact; optional `tags`, `packages`, and `boundRecordId` |
| `mobile_logcat_stop`  | Stop the stream and return `{ path, artifactUri, lines, durationMs }`                             |

Bind a log session to a `recordId` when correlating launch tags with black-frame windows from analysis.

### Visual regression workflow

For black frames, wrong launcher ownership, or theme flashes across displays:

1. `mobile_record_start` on the logical display under test
2. Optionally `mobile_logcat_start` (diagnostics) with `boundRecordId`
3. `mobile_focus_trace` for the involved display IDs around the scenario (or sample between actions)
4. `mobile_record_mark` before/after actions while sending `mobile_input_key` / taps
5. Optionally `mobile_screen_capture_pair` at a marked moment
6. `mobile_record_stop` → `mobile_analyze_recording` with `exportSampleFrames: true`
7. Fail the scenario if `blackFrameCount > 0`, or if focus samples show an unexpected package (for example the system launcher) on a display between marks

## Multi-display model

Android has multiple identifier spaces:

- logical display IDs are small framework integers used by WindowManager, ActivityManager, `input -d`, and accessibility;
- physical display IDs are unsigned 64-bit SurfaceFlinger identifiers used by `screencap -d` and `screenrecord --display-id`;
- virtual displays may have a logical ID but no capturable physical ID.

Physical IDs are represented as decimal strings so JavaScript never loses precision. Correlation uses `DisplayInfo.uniqueId`, display addresses, and bounded evidence from:

- `dumpsys display`
- `dumpsys SurfaceFlinger --display-id`
- `dumpsys input`
- `dumpsys window displays`
- `dumpsys activity activities`

Requested activity placement is always treated as a request. Callers should inspect tasks and window focus to verify the observed result.

## Input behavior

The ADB backend probes the device's own `input` help and exposes only supported options:

- keyboard, dpad, gamepad, and touchscreen sources;
- display targeting with `-d`;
- key press, long press, double tap, and explicit duration where supported;
- any symbolic or numeric Android keycode, including face buttons, shoulders, triggers, thumb buttons, START, SELECT, and MODE;
- taps, swipes, text, and modern command capabilities reported by inspection.

ADB shell gamepad events still use a synthetic virtual device identity. They are not equivalent to a physical controller descriptor.

## Optional companion

Build:

```bash
gradle -p companion :app:assembleDebug :app:assembleDebugAndroidTest :fixture:assembleDebug
```

Outputs:

- `companion/app/build/outputs/apk/debug/app-debug.apk`
- `companion/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk`

Enable the `companion` profile, then call:

1. `mobile_companion_install`
2. `mobile_companion_start`
3. `mobile_companion_key` or `mobile_companion_windows`
4. `mobile_companion_stop`

The host creates a random per-session token and an owned `adb forward` to a local-abstract socket. Frames are length-prefixed JSON with a 1 MiB maximum. The instrumentation process preserves key `downTime`, supports explicit press/down/up and repeats, and releases all held keys when a client disconnects.

Platform limits are reported rather than hidden:

- keys follow Android's focused-display policy because public `KeyEvent` has no portable display setter;
- a normal APK cannot hold the signature-only `INJECT_EVENTS` permission;
- synthetic gamepad events do not have physical controller identity;
- accessibility exposes interactive windows and nodes, not secure or inaccessible rendering.

## Security

- No `/bin/sh -c` or command-string interpolation.
- Device serials, packages, components, keycodes, tags, permissions, paths, and display IDs are validated.
- Mutations are serialized per device.
- Subprocesses have deadlines, cancellation, and output caps.
- Push paths must remain under the server host root.
- Pull/push device paths are restricted to shared storage and `/data/local/tmp`.
- Raw shell, root, remount, verity, SELinux, partition, credential, and system-process operations are not exposed.

See [SECURITY.md](SECURITY.md) for reporting and deployment guidance.

## Testing and development

```bash
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
gradle -p companion :app:assembleDebug :app:assembleDebugAndroidTest
```

The local suite covers:

- ADB subprocess timeouts, cancellation, output limits, and argv safety;
- logical/physical display parsing, virtual displays, capture routing, and launch verification;
- UI hierarchy parsing and matching;
- per-device mutation serialization;
- host/device path confinement and typed command validation;
- MCP tool-profile registration and Streamable HTTP security;
- artifact storage and traversal protection;
- companion framing and request correlation.

Device integration checks are intentionally separate from deterministic unit tests. Multi-display acceptance additionally verifies physical-ID capture and recording, all-display accessibility windows, authenticated companion forwarding, and independent key down/up injection.

Never silently select the first connected device: pass the exact serial returned by `mobile_devices_list`.

Occasional `Logical display N is not available` flakes on multi-display handhelds usually clear after re-listing displays, tapping the target display (or waking it), and retrying. The device acceptance scripts recover via `runWithDisplay`.

### Repeatable device acceptance

The generic suite is read-mostly. It captures requested displays and can optionally record, inspect one package, and exercise an already-installed companion:

```bash
POLYSCREEN_DEVICE=<serial> \
POLYSCREEN_DISPLAY_IDS=0,4 \
POLYSCREEN_RECORD=1 \
POLYSCREEN_TEST_PACKAGE=com.example.app \
POLYSCREEN_COMPANION=1 \
pnpm test:device
```

The destructive suite uses a dedicated integration-fixture APK, separate from the production companion. It installs and launches the fixture, verifies tap/swipe/drag/text input, grants and revokes CAMERA, force-stops the fixture, and uninstalls it during cleanup:

```bash
POLYSCREEN_DEVICE=<serial> \
POLYSCREEN_DISPLAY_ID=0 \
POLYSCREEN_ALLOW_DESTRUCTIVE=1 \
pnpm test:thor:destructive
```

The destructive suite refuses to run without the acknowledgement variable and never chooses a device serial implicitly. Override `POLYSCREEN_FIXTURE_APK` when testing an externally built fixture.

## License

Apache-2.0.
