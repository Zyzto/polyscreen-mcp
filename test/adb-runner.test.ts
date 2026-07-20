import { describe, expect, it } from "vitest";

import {
  AdbCommandError,
  AdbRunner,
  quoteRemoteShellArg,
} from "../src/android/adb-runner.js";

describe("AdbRunner process safety", () => {
  const runner = new AdbRunner(process.execPath);

  it("passes argv without a shell", async () => {
    await expect(
      runner.text([
        "-e",
        "process.stdout.write(process.argv[1])",
        "value;$(ignored)",
      ]),
    ).resolves.toBe("value;$(ignored)");
  });

  it("returns structured failures for non-zero exits", async () => {
    try {
      await runner.run([
        "-e",
        "process.stderr.write('failure'); process.exit(7)",
      ]);
      throw new Error("Expected the command to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AdbCommandError);
      expect((error as AdbCommandError).result.exitCode).toBe(7);
      expect((error as AdbCommandError).result.stderr.toString()).toBe(
        "failure",
      );
    }
  });

  it("enforces subprocess deadlines", async () => {
    await expect(
      runner.run(["-e", "setTimeout(() => {}, 1000)"], { timeoutMs: 25 }),
    ).rejects.toThrow("timed out");
  });

  it("caps combined stdout and stderr", async () => {
    await expect(
      runner.run(["-e", "process.stdout.write('x'.repeat(100))"], {
        maxOutputBytes: 16,
      }),
    ).rejects.toThrow("exceeded 16 bytes");
  });

  it("propagates cancellation", async () => {
    const abort = new AbortController();
    const operation = runner.run(["-e", "setTimeout(() => {}, 1000)"], {
      signal: abort.signal,
    });
    abort.abort(new Error("cancelled by test"));
    await expect(operation).rejects.toThrow("cancelled by test");
  });

  it("does not spawn an already-cancelled operation", async () => {
    const abort = new AbortController();
    abort.abort(new Error("cancelled before spawn"));
    await expect(
      runner.run(["-e", "process.exit(99)"], { signal: abort.signal }),
    ).rejects.toThrow("cancelled before spawn");
  });

  it("quotes values that ADB forwards through the device shell", () => {
    expect(quoteRemoteShellArg("hello; id")).toBe("'hello; id'");
    expect(quoteRemoteShellArg("it's safe")).toBe(`'it'"'"'s safe'`);
    expect(() => quoteRemoteShellArg("bad\0value")).toThrow("NUL");
  });
});
