import { createServer, Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { CompanionConnection } from "../src/backends/companion.js";

describe("CompanionConnection", () => {
  const sockets: Socket[] = [];

  afterEach(() => {
    for (const socket of sockets) socket.destroy();
  });

  it("uses length-prefixed JSON and correlates responses", async () => {
    const server = createServer((socket) => {
      sockets.push(socket);
      socket.once("data", (frame) => {
        const bytes = Buffer.from(frame);
        const length = bytes.readUInt32BE(0);
        const request = JSON.parse(
          bytes.subarray(4, 4 + length).toString("utf8"),
        ) as {
          id: number;
          op: string;
        };
        const payload = Buffer.from(
          JSON.stringify({ id: request.id, ok: true, operation: request.op }),
        );
        const response = Buffer.alloc(payload.length + 4);
        response.writeUInt32BE(payload.length, 0);
        payload.copy(response, 4);
        socket.write(response);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (typeof address === "string" || address === null)
      throw new Error("Expected TCP address");

    const socket = new Socket();
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.connect(address.port, "127.0.0.1", resolve);
    });
    const connection = new CompanionConnection(socket);

    await expect(connection.request({ op: "hello" })).resolves.toMatchObject({
      ok: true,
      operation: "hello",
    });
    connection.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects malformed device frames without crashing the process", async () => {
    const server = createServer((socket) => {
      sockets.push(socket);
      socket.once("data", () => {
        const payload = Buffer.from("{not-json");
        const response = Buffer.alloc(payload.length + 4);
        response.writeUInt32BE(payload.length, 0);
        payload.copy(response, 4);
        socket.write(response);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (typeof address === "string" || address === null) {
      throw new Error("Expected TCP address");
    }

    const socket = new Socket();
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.connect(address.port, "127.0.0.1", resolve);
    });
    const connection = new CompanionConnection(socket);

    await expect(connection.request({ op: "hello" })).rejects.toThrow();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
