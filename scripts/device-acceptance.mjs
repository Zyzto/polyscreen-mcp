import {
  assert,
  connectIntegrationClient,
  requiredEnvironment,
} from "./integration-client.mjs";

const serial = requiredEnvironment("BETTER_MOBILE_DEVICE");
const displayIds = (process.env.BETTER_MOBILE_DISPLAY_IDS ?? "0")
  .split(",")
  .map((value) => Number(value.trim()));
if (
  displayIds.length === 0 ||
  displayIds.some((value) => !Number.isInteger(value) || value < 0)
) {
  throw new Error("BETTER_MOBILE_DISPLAY_IDS must be comma-separated integers");
}

const shouldRecord = process.env.BETTER_MOBILE_RECORD === "1";
const shouldTestCompanion = process.env.BETTER_MOBILE_COMPANION === "1";
const packageName = process.env.BETTER_MOBILE_TEST_PACKAGE?.trim();
const { client, call } = await connectIntegrationClient("device-acceptance");
let companionStarted = false;
const summary = { serial, displayIds };

try {
  const tools = await client.listTools();
  summary.toolCount = tools.tools.length;

  const devices = await call("mobile_devices_list", {});
  const device = devices.devices.find(
    (candidate) => candidate.serial === serial && candidate.state === "device",
  );
  assert(device, `Device is not online: ${serial}`);
  summary.device = device;

  const inspection = await call("mobile_device_inspect", {
    serial,
    refresh: true,
  });
  summary.capabilities = {
    apiLevel: inspection.capabilities.apiLevel,
    model: inspection.capabilities.model,
    inputDisplayTargeting: inspection.capabilities.input.displayTargeting,
  };

  const listed = await call("mobile_displays_list", { serial });
  summary.displays = [];
  summary.captures = [];
  summary.recordings = [];
  for (const displayId of displayIds) {
    const display = listed.displays.find(
      (candidate) => candidate.logicalId === displayId,
    );
    assert(display, `Logical display is unavailable: ${displayId}`);
    assert(
      display.physicalId,
      `Logical display lacks physical correlation: ${displayId}`,
    );
    summary.displays.push({
      logicalId: display.logicalId,
      physicalId: display.physicalId,
      width: display.width,
      height: display.height,
      state: display.state,
    });

    const capture = await call("mobile_screen_capture", {
      serial,
      displayId,
      saveArtifact: true,
    });
    assert(capture.sizeBytes > 8, `Display ${displayId} capture was empty`);
    assert(capture.artifactUri, `Display ${displayId} capture was not saved`);
    const resource = await client.readResource({ uri: capture.artifactUri });
    assert(
      resource.contents.length === 1 && resource.contents[0].blob,
      `Display ${displayId} artifact could not be read`,
    );
    summary.captures.push({
      displayId,
      sizeBytes: capture.sizeBytes,
      artifactUri: capture.artifactUri,
    });

    if (shouldRecord) {
      const recording = await call("mobile_screen_record", {
        serial,
        displayId,
        durationSeconds: 1,
      });
      assert(
        recording.sizeBytes > 0,
        `Display ${displayId} recording was empty`,
      );
      summary.recordings.push({
        displayId,
        sizeBytes: recording.sizeBytes,
        artifactUri: recording.artifactUri,
      });
    }
  }

  const diagnostics = await call("mobile_diagnostics_collect", {
    serial,
    sections: ["display", "window", "input", "battery"],
  });
  summary.diagnostics = Object.fromEntries(
    Object.entries(diagnostics.sections).map(([name, value]) => [
      name,
      Buffer.byteLength(value),
    ]),
  );

  const packages = await call("mobile_packages_list", {
    serial,
    userId: 0,
    thirdPartyOnly: true,
    includeDisabled: true,
  });
  summary.thirdPartyPackages = packages.packages.length;

  if (packageName) {
    const app = await call("mobile_app_inspect", { serial, packageName });
    assert(
      app.dump.includes(packageName),
      `Package dump does not mention ${packageName}`,
    );
    const performance = await call("mobile_performance_snapshot", {
      serial,
      packageName,
    });
    summary.package = {
      name: packageName,
      dumpBytes: Buffer.byteLength(app.dump),
      performanceSections: Object.keys(performance.sections),
    };
  }

  if (shouldTestCompanion) {
    const started = await call("mobile_companion_start", { serial });
    companionStarted = true;
    const windows = await call("mobile_companion_windows", { serial });
    await call("mobile_companion_key", {
      serial,
      keyCode: 19,
      action: "down",
      source: "dpad",
      repeat: 0,
      metaState: 0,
    });
    await call("mobile_companion_key", {
      serial,
      keyCode: 19,
      action: "up",
      source: "dpad",
      repeat: 0,
      metaState: 0,
    });
    await call("mobile_companion_stop", { serial });
    companionStarted = false;
    summary.companion = {
      protocol: started.session.protocol,
      backend: started.session.backend,
      displayCount: windows.result.displays.length,
      keyLifecycle: true,
    };
  }

  console.log(JSON.stringify(summary, null, 2));
} finally {
  if (companionStarted) {
    await client
      .callTool({
        name: "mobile_companion_stop",
        arguments: { serial },
      })
      .catch(() => undefined);
  }
  await client.close().catch(() => undefined);
}
