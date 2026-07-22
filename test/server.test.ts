import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { createPolyScreenServer } from "../src/mcp/server.js";

describe("MCP server contract", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("advertises a compact core and enables optional profiles explicitly", async () => {
    const server = createPolyScreenServer({
      profiles: new Set(["core", "diagnostics", "apps"]),
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });

    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("mobile_displays_list");
    expect(names).toContain("mobile_input_key_combination");
    expect(names).toContain("mobile_record_start");
    expect(names).toContain("mobile_record_mark");
    expect(names).toContain("mobile_record_stop");
    expect(names).toContain("mobile_analyze_recording");
    expect(names).toContain("mobile_focus_trace");
    expect(names).toContain("mobile_screen_capture_pair");
    expect(names).toContain("mobile_logcat");
    expect(names).toContain("mobile_logcat_start");
    expect(names).toContain("mobile_logcat_stop");
    expect(names).toContain("mobile_broadcast_send");
    expect(names).not.toContain("mobile_companion_key");
  });
});
