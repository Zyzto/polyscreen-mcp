import { describe, expect, it } from "vitest";

import { findUiNodes, parseUiNodes } from "../src/android/ui.js";

describe("UI hierarchy", () => {
  const xml = `<?xml version="1.0"?>
    <hierarchy>
      <node text="Library" resource-id="com.example:id/library" class="android.widget.TextView"
        content-desc="Game library" bounds="[10,20][210,120]" />
      <node text="Settings" resource-id="com.example:id/settings" class="android.widget.Button"
        content-desc="" bounds="[10,140][210,240]" />
    </hierarchy>`;

  it("parses accessible labels and centers", () => {
    const nodes = parseUiNodes(xml);
    expect(nodes[0]).toMatchObject({
      text: "Library",
      contentDescription: "Game library",
      center: { x: 110, y: 70 },
    });
  });

  it("finds nodes case-insensitively by default", () => {
    expect(findUiNodes(parseUiNodes(xml), { text: "setting" })).toHaveLength(1);
  });
});
