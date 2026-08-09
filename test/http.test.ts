import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import { startStreamableHttpServer } from "../src/mcp/http.js";
import { createPolyScreenRuntime } from "../src/mcp/server.js";

describe("Streamable HTTP security", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("rejects untrusted origins and missing bearer tokens", async () => {
    const runtime = createPolyScreenRuntime();
    const { httpServer, handler } = await startStreamableHttpServer(
      runtime.createServer,
      {
        port: 0,
        token: "test-token",
      },
    );
    cleanups.push(async () => {
      await handler.close();
      await runtime.close();
      await closeHttpServer(httpServer);
    });
    const url = serverUrl(httpServer);

    const unauthorized = await fetch(url);
    expect(unauthorized.status).toBe(401);

    const hostile = await fetch(url, {
      headers: {
        authorization: "Bearer test-token",
        origin: "https://attacker.example",
      },
    });
    expect(hostile.status).toBe(403);
  });

  it("connects an authenticated MCP client and calls tools", async () => {
    const runtime = createPolyScreenRuntime();
    const { httpServer, handler } = await startStreamableHttpServer(
      runtime.createServer,
      {
        port: 0,
        token: "test-token",
      },
    );
    const url = serverUrl(httpServer);
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: { authorization: "Bearer test-token" },
      },
    });
    const client = new Client(
      { name: "http-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    cleanups.push(async () => {
      await client.close().catch(() => undefined);
      await handler.close();
      await runtime.close();
      await closeHttpServer(httpServer);
    });

    await client.connect(transport);
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toContain(
      "mobile_devices_list",
    );
  });

  it("closes cleanly while clients may still be connected", async () => {
    const runtime = createPolyScreenRuntime();
    const { httpServer, handler } = await startStreamableHttpServer(
      runtime.createServer,
      {
        port: 0,
        token: "test-token",
      },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(serverUrl(httpServer)),
      {
        requestInit: {
          headers: { authorization: "Bearer test-token" },
        },
      },
    );
    const client = new Client(
      { name: "sse-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    cleanups.push(async () => {
      await client.close().catch(() => undefined);
      await handler.close().catch(() => undefined);
      await runtime.close().catch(() => undefined);
      await closeHttpServer(httpServer);
    });
    await client.connect(transport);
    expect(await connectionCount(httpServer)).toBeGreaterThan(0);

    await expect(
      Promise.race([
        (async () => {
          await handler.close();
          await runtime.close();
          await closeHttpServer(httpServer);
        })(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("HTTP shutdown timed out with active SSE")),
            2_000,
          ),
        ),
      ]),
    ).resolves.toBeUndefined();
  });
});

function serverUrl(httpServer: import("node:http").Server): string {
  const address = httpServer.address();
  if (typeof address === "string" || address === null) {
    throw new Error("Expected TCP address");
  }
  return `http://127.0.0.1:${address.port}/mcp`;
}

async function closeHttpServer(
  httpServer: import("node:http").Server,
): Promise<void> {
  if (!httpServer.listening) return;
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function connectionCount(
  httpServer: import("node:http").Server,
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    httpServer.getConnections((error, count) => {
      if (error) reject(error);
      else resolve(count);
    });
  });
}
