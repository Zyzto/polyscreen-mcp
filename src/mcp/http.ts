import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export interface HttpServerOptions {
  port: number;
  token?: string | undefined;
}

export async function startStreamableHttpServer(
  server: McpServer,
  options: HttpServerOptions,
): Promise<{
  httpServer: HttpServer;
  transport: StreamableHTTPServerTransport;
}> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
  } as unknown as ConstructorParameters<
    typeof StreamableHTTPServerTransport
  >[0]);
  await server.connect(transport as unknown as Transport);

  const httpServer = createServer(async (request, response) => {
    try {
      if (request.url !== "/mcp") {
        response.writeHead(404).end("Not found");
        return;
      }
      if (!isAllowedHost(request.headers.host)) {
        response.writeHead(403).end("Invalid Host");
        return;
      }
      if (!isAllowedOrigin(request.headers.origin)) {
        response.writeHead(403).end("Invalid Origin");
        return;
      }
      if (
        options.token !== undefined &&
        request.headers.authorization !== `Bearer ${options.token}`
      ) {
        response
          .writeHead(401, { "WWW-Authenticate": "Bearer" })
          .end("Unauthorized");
        return;
      }
      await transport.handleRequest(request, response);
    } catch (error) {
      if (!response.headersSent) response.writeHead(500);
      response.end(
        error instanceof Error ? error.message : "Internal server error",
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });
  return { httpServer, transport };
}

function isAllowedHost(host: string | undefined): boolean {
  if (!host) return false;
  const hostname = host.startsWith("[")
    ? host.slice(1, host.indexOf("]"))
    : host.split(":")[0];
  return (
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
  );
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const hostname = new URL(origin).hostname;
    return (
      hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
    );
  } catch {
    return false;
  }
}
