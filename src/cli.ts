#!/usr/bin/env node

import type { Server as HttpServer } from "node:http";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Command } from "commander";

import { startStreamableHttpServer } from "./mcp/http.js";
import { createPolyScreenServer } from "./mcp/server.js";
import { PACKAGE_VERSION } from "./version.js";

const program = new Command()
  .name("polyscreen-mcp")
  .description("Capability-driven Android automation MCP server")
  .option(
    "-p, --profile <profile...>",
    "Enable tool profiles: core, diagnostics, companion, apps, files, performance, device-admin, emulator, unsafe, all",
    ["core"],
  )
  .option(
    "--listen <port>",
    "Serve Streamable HTTP on 127.0.0.1 instead of stdio",
  )
  .option(
    "--token <token>",
    "Require a static bearer token for Streamable HTTP",
  )
  .parse();

const options = program.opts<{
  profile: string[];
  listen?: string;
  token?: string;
}>();
const server = createPolyScreenServer({
  profiles: new Set(options.profile),
});
let httpServer: HttpServer | undefined;

const shutdown = async (): Promise<void> => {
  await server.close();
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  }
  process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

if (options.listen !== undefined) {
  const port = Number(options.listen);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid listen port: ${options.listen}`);
  }
  ({ httpServer } = await startStreamableHttpServer(server, {
    port,
    token: options.token,
  }));
  console.error(
    `PolyScreen MCP ${PACKAGE_VERSION} listening on http://127.0.0.1:${port}/mcp (${server.listRegisteredTools().length} tools)`,
  );
  server.notifyToolListChanged();
} else {
  await server.connect(new StdioServerTransport());
  console.error(
    `[polyscreen-mcp] ${PACKAGE_VERSION} connected over stdio with ${server.listRegisteredTools().length} tools`,
  );
  server.notifyToolListChanged();
}
