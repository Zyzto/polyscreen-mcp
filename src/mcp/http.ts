import { createServer, type Server as HttpServer } from "node:http";

import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  type McpHttpHandler,
  type McpServerFactory,
} from "@modelcontextprotocol/server";

export interface HttpServerOptions {
  port: number;
  token?: string | undefined;
}

export async function startStreamableHttpServer(
  factory: McpServerFactory,
  options: HttpServerOptions,
): Promise<{
  httpServer: HttpServer;
  handler: McpHttpHandler;
}> {
  const handler = createMcpHandler(factory);
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const httpServer = createServer((request, response) => {
    try {
      if (request.url !== "/mcp" && !request.url?.startsWith("/mcp?")) {
        response.writeHead(404).end("Not found");
        return;
      }
      if (!validateHost(request, response)) return;
      if (!validateOrigin(request, response)) return;
      if (
        options.token !== undefined &&
        request.headers.authorization !== `Bearer ${options.token}`
      ) {
        response
          .writeHead(401, { "WWW-Authenticate": "Bearer" })
          .end("Unauthorized");
        return;
      }
      void nodeHandler(
        request as Parameters<typeof nodeHandler>[0],
        response as Parameters<typeof nodeHandler>[1],
      );
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
  return { httpServer, handler };
}
