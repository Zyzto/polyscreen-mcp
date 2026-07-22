import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  createPackageLineFilter,
  lineMatchesPackageFilter,
} from "../src/android/logcat-sessions.js";

describe("package logcat filter", () => {
  it("keeps threadtime lines by PID or package name", async () => {
    const pids = new Set([4242]);
    const filter = createPackageLineFilter(
      new Set(["com.example", "com.game"]),
      () => pids,
    );
    const input = Readable.from([
      "01-01 00:00:00.000  4242  100 I Tag: hello from pid\n",
      "01-01 00:00:00.001  9999  100 I Tag: unrelated noise\n",
      "01-01 00:00:00.002  1111  100 I ActivityManager: Start com.game\n",
    ]);
    const chunks: string[] = [];
    for await (const chunk of input.pipe(filter)) {
      chunks.push(Buffer.from(chunk).toString("utf8"));
    }
    const text = chunks.join("");
    expect(text).toContain("hello from pid");
    expect(text).toContain("com.game");
    expect(text).not.toContain("unrelated");
  });

  it("matches PID field without requiring package substring", () => {
    expect(
      lineMatchesPackageFilter(
        "01-01 00:00:00.000  4242  100 I Tag: silent",
        new Set(["com.example"]),
        new Set([4242]),
      ),
    ).toBe(true);
  });
});
