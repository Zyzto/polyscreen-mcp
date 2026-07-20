import { access } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assert,
  connectIntegrationClient,
  requiredEnvironment,
  waitForNode,
} from "./integration-client.mjs";

if (process.env.POLYSCREEN_ALLOW_DESTRUCTIVE !== "1") {
  throw new Error(
    "Set POLYSCREEN_ALLOW_DESTRUCTIVE=1 to acknowledge install, permission, force-stop, and uninstall tests",
  );
}

const serial = requiredEnvironment("POLYSCREEN_DEVICE");
const displayId = Number(process.env.POLYSCREEN_DISPLAY_ID ?? "0");
if (!Number.isInteger(displayId) || displayId < 0) {
  throw new Error("POLYSCREEN_DISPLAY_ID must be a non-negative integer");
}

const packageName = "dev.polyscreen.fixture";
const activity = "dev.polyscreen.fixture.IntegrationFixtureActivity";
const cameraPermission = "android.permission.CAMERA";
const fixtureApk = resolve(
  process.env.POLYSCREEN_FIXTURE_APK ??
    "companion/fixture/build/outputs/apk/debug/fixture-debug.apk",
);
await access(fixtureApk);

const { client, call } = await connectIntegrationClient(
  "thor-destructive-acceptance",
);
const summary = { serial, displayId, packageName };
let cleanupRequired = true;

const findFixtureNode = async (resourceName) =>
  await waitForNode(call, {
    serial,
    displayId,
    query: {
      resourceId: `${packageName}:id/${resourceName}`,
    },
  });

const waitForStatus = async (text) =>
  await waitForNode(call, {
    serial,
    displayId,
    query: { text },
  });

try {
  const devices = await call("mobile_devices_list", {});
  assert(
    devices.devices.some(
      (device) => device.serial === serial && device.state === "device",
    ),
    `Thor is not online: ${serial}`,
  );

  await call("mobile_app_install", {
    serial,
    path: fixtureApk,
    replace: true,
  });
  await call("mobile_input_key", {
    serial,
    displayId,
    key: "KEYCODE_WAKEUP",
    source: "keyboard",
    action: "press",
  });
  const launch = await call("mobile_app_launch", {
    serial,
    packageName,
    displayId,
    activity,
  });
  assert(
    launch.data.observedFocusedDisplayId === displayId,
    `Fixture focus was not observed on display ${displayId}`,
  );
  await waitForStatus("ready");
  summary.lifecycle = { installed: true, launched: true };

  const tapTarget = await findFixtureNode("integration_tap_target");
  assert(tapTarget.center, "Tap fixture has no center coordinate");
  await call("mobile_input_tap", {
    serial,
    displayId,
    x: tapTarget.center.x,
    y: tapTarget.center.y,
  });
  await waitForStatus("tap:1");
  summary.tap = true;

  const gestureTarget = await findFixtureNode("integration_gesture_target");
  assert(gestureTarget.bounds, "Gesture fixture has no bounds");
  const bounds = gestureTarget.bounds;
  const centerY = Math.round((bounds.top + bounds.bottom) / 2);
  const leftX = Math.round(bounds.left + (bounds.right - bounds.left) * 0.25);
  const rightX = Math.round(bounds.left + (bounds.right - bounds.left) * 0.75);

  await call("mobile_input_swipe", {
    serial,
    displayId,
    start: { x: leftX, y: centerY },
    end: { x: rightX, y: centerY },
    durationMs: 300,
  });
  await waitForStatus("gesture:right");
  summary.swipe = true;

  await call("mobile_input_drag", {
    serial,
    displayId,
    start: { x: rightX, y: centerY },
    end: { x: leftX, y: centerY },
    durationMs: 700,
  });
  await waitForStatus("gesture:left");
  summary.drag = true;

  const textInput = await findFixtureNode("integration_text_input");
  assert(textInput.center, "Text fixture has no center coordinate");
  await call("mobile_input_tap", {
    serial,
    displayId,
    x: textInput.center.x,
    y: textInput.center.y,
  });
  const expectedText = "Thor integration 42";
  await call("mobile_input_text", {
    serial,
    displayId,
    text: expectedText,
  });
  await waitForNode(call, {
    serial,
    displayId,
    query: { text: expectedText },
  });
  summary.text = expectedText;

  await call("mobile_permission_set", {
    serial,
    action: "grant",
    packageName,
    permission: cameraPermission,
    userId: 0,
  });
  const granted = await call("mobile_app_inspect", { serial, packageName });
  assert(
    granted.dump.includes(`${cameraPermission}: granted=true`),
    "CAMERA permission was not granted",
  );
  await call("mobile_permission_set", {
    serial,
    action: "revoke",
    packageName,
    permission: cameraPermission,
    userId: 0,
  });
  const revoked = await call("mobile_app_inspect", { serial, packageName });
  assert(
    revoked.dump.includes(`${cameraPermission}: granted=false`),
    "CAMERA permission was not revoked",
  );
  summary.permission = { grant: true, revoke: true };

  await call("mobile_app_stop", {
    serial,
    packageName,
    userId: "current",
  });
  summary.lifecycle.stopped = true;

  await call("mobile_app_uninstall", {
    serial,
    packageName,
    keepData: false,
  });
  const afterUninstall = await call("mobile_packages_list", {
    serial,
    userId: 0,
    thirdPartyOnly: false,
    includeDisabled: true,
  });
  assert(
    !afterUninstall.packages.includes(packageName),
    "Fixture package remains installed after uninstall",
  );
  summary.lifecycle.uninstalled = true;
  cleanupRequired = false;
  summary.lifecycle.cleaned = true;

  console.log(JSON.stringify(summary, null, 2));
} finally {
  if (cleanupRequired) {
    await client
      .callTool({
        name: "mobile_app_stop",
        arguments: { serial, packageName, userId: "current" },
      })
      .catch(() => undefined);
    await client
      .callTool({
        name: "mobile_app_uninstall",
        arguments: { serial, packageName, keepData: false },
      })
      .catch((error) =>
        console.error("WARNING: fixture cleanup failed", error),
      );
  }
  await client.close().catch(() => undefined);
}
