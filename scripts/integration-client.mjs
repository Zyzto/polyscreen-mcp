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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for UI node ${JSON.stringify(query)}${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }`,
  );
}
