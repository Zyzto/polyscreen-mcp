import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { createPolyScreenServer } from "../src/mcp/server.js";
import { CORE_DETECTIVE_TOOLS, PACKAGE_VERSION } from "../src/version.js";

describe("MCP server contract", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("advertises detective tools and optional profiles", async () => {
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
    for (const tool of CORE_DETECTIVE_TOOLS) {
      expect(names).toContain(tool);
    }
    expect(names).toContain("mobile_server_info");
    expect(names).toContain("mobile_focus_trace_start");
    expect(names).toContain("mobile_focus_trace_stop");
    expect(names).toContain("mobile_artifacts_list");
    expect(names).toContain("mobile_logcat_start");
    expect(names).toContain("mobile_diagnostics_activity_tops");
    expect(names).toContain("mobile_broadcast_send");
    expect(names).not.toContain("mobile_companion_key");
    expect(server.listRegisteredTools()).toEqual([...names].sort());
  });

  it("exposes version and tool list via mobile_server_info", async () => {
    const server = createPolyScreenServer({ profiles: new Set(["core"]) });
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

    const response = await client.callTool({
      name: "mobile_server_info",
      arguments: {},
    });
    const info = response.structuredContent as {
      version: string;
      toolCount: number;
      toolNames: string[];
      profiles: string[];
    };
    expect(info.version).toBe(PACKAGE_VERSION);
    expect(info.profiles).toEqual(["core"]);
    expect(info.toolCount).toBe(info.toolNames.length);
    expect(info.toolNames).toContain("mobile_analyze_recording");
  });
});
