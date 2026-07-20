import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set explicitly`);
  return value;
}

export async function connectIntegrationClient(name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/cli.js", "--profile", "all"],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);

  const call = async (toolName, arguments_) => {
    const result = await client.callTool({
      name: toolName,
      arguments: arguments_,
    });
    if (result.isError) {
      const message = result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      throw new Error(`${toolName} failed: ${message}`);
    }
    if (!result.structuredContent) {
      throw new Error(`${toolName} returned no structured content`);
    }
    return result.structuredContent;
  };

  return { client, call };
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pokeDisplay(call, serial, display) {
  await call("mobile_input_key", {
    serial,
    displayId: 0,
    key: "KEYCODE_WAKEUP",
    source: "keyboard",
    action: "press",
  }).catch(() => undefined);

  if (!display?.width || !display?.height) return;
  await call("mobile_input_tap", {
    serial,
    displayId: display.logicalId,
    x: Math.floor(display.width / 2),
    y: Math.floor(display.height / 2),
  }).catch(() => undefined);
}

async function ensureDisplay(
  call,
  { serial, displayId, requirePhysical = false, timeoutMs = 15_000 },
) {
  const deadline = Date.now() + timeoutMs;
  let lastListing;
  let lastError;

  while (Date.now() < deadline) {
    try {
      lastListing = await call("mobile_displays_list", { serial });
      const display = lastListing.displays.find(
        (candidate) => candidate.logicalId === displayId,
      );
      if (display && (!requirePhysical || display.physicalId)) {
        if (display.state && /OFF|DOZE/i.test(display.state)) {
          await pokeDisplay(call, serial, display);
          await sleep(300);
          continue;
        }
        return display;
      }
      await pokeDisplay(call, serial, display);
    } catch (error) {
      lastError = error;
    }
    await sleep(400);
  }

  throw new Error(
    `Logical display ${displayId} is not available on ${serial}` +
      (lastError instanceof Error ? `: ${lastError.message}` : "") +
      (lastListing
        ? `; seen=${JSON.stringify(
            lastListing.displays.map((display) => ({
              logicalId: display.logicalId,
              physicalId: display.physicalId,
              state: display.state,
            })),
          )}`
        : ""),
  );
}

export async function runWithDisplay(
  call,
  displayOptions,
  action,
  { retries = 2 } = {},
) {
  let attempt = 0;
  for (;;) {
    const display = await ensureDisplay(call, displayOptions);
    try {
      return { display, result: await action(display) };
    } catch (error) {
      const unavailable =
        error instanceof Error &&
        /Logical display .* is not available/i.test(error.message);
      if (!unavailable || attempt >= retries) throw error;
      attempt += 1;
      await sleep(400);
    }
  }
}

export async function waitForNode(
  call,
  { serial, displayId, query, timeoutMs = 10_000 },
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await call("mobile_ui_find", {
        serial,
        displayId,
        ...query,
        exact: true,
      });
      if (result.matches.length > 0) return result.matches[0];
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(
    `Timed out waiting for UI node ${JSON.stringify(query)}${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }`,
  );
}
