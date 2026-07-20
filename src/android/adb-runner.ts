import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { CommandResult } from "./types.js";

export function quoteRemoteShellArg(value: string): string {
  if (value.includes("\0")) {
    throw new Error("Remote shell arguments cannot contain NUL bytes");
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export interface RunOptions {
  serial?: string | undefined;
  timeoutMs?: number | undefined;
  maxOutputBytes?: number | undefined;
  signal?: AbortSignal | undefined;
  stdin?: Buffer | string | undefined;
}

export class AdbCommandError extends Error {
  constructor(
    message: string,
    readonly result: CommandResult,
  ) {
    super(message);
    this.name = "AdbCommandError";
  }
}

export class AdbRunner {
  constructor(readonly executable = process.env.ADB_PATH ?? "adb") {}

  async run(
    args: readonly string[],
    options: RunOptions = {},
  ): Promise<CommandResult> {
    options.signal?.throwIfAborted();
    const argv = options.serial ? ["-s", options.serial, ...args] : [...args];
    const timeoutMs = options.timeoutMs ?? 30_000;
    const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
    const startedAt = performance.now();

    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(this.executable, argv, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;

      const terminate = (reason: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        child.kill("SIGKILL");
        reject(reason);
      };

      const onAbort = (): void =>
        terminate(options.signal?.reason ?? new Error("Operation aborted"));

      const timer = setTimeout(() => {
        terminate(new Error(`ADB command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      options.signal?.addEventListener("abort", onAbort, { once: true });

      const collect =
        (target: Buffer[]) =>
        (chunk: Buffer): void => {
          outputBytes += chunk.length;
          if (outputBytes > maxOutputBytes) {
            terminate(new Error(`ADB output exceeded ${maxOutputBytes} bytes`));
            return;
          }
          target.push(chunk);
        };

      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      child.on("error", terminate);
      child.on("close", (code) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;

        const result: CommandResult = {
          argv,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          exitCode: code ?? -1,
          durationMs: Math.round(performance.now() - startedAt),
        };
        if (result.exitCode !== 0) {
          reject(
            new AdbCommandError(
              `ADB command failed (${result.exitCode}): ${result.stderr.toString("utf8").trim()}`,
              result,
            ),
          );
          return;
        }
        resolve(result);
      });

      if (options.stdin !== undefined) child.stdin.end(options.stdin);
      else child.stdin.end();
    });
  }

  async text(
    args: readonly string[],
    options: RunOptions = {},
  ): Promise<string> {
    return (await this.run(args, options)).stdout.toString("utf8").trim();
  }

  operationId(): string {
    return randomUUID();
  }
}
