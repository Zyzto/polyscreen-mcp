import { AdbRunner, type RunOptions } from "../src/android/adb-runner.js";
import type { CommandResult } from "../src/android/types.js";

export class FakeAdbRunner extends AdbRunner {
  readonly calls: Array<{ args: string[]; options: RunOptions }> = [];
  readonly responses = new Map<
    string,
    { stdout: Buffer; stderr: Buffer; exitCode: number }
  >();
  #nextOperation = 1;

  respond(
    args: readonly string[],
    stdout: string | Buffer,
    options: { serial?: string; stderr?: string; exitCode?: number } = {},
  ): this {
    this.responses.set(this.key(args, options.serial), {
      stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
      stderr: Buffer.from(options.stderr ?? ""),
      exitCode: options.exitCode ?? 0,
    });
    return this;
  }

  override async run(
    args: readonly string[],
    options: RunOptions = {},
  ): Promise<CommandResult> {
    this.calls.push({ args: [...args], options });
    const response = this.responses.get(this.key(args, options.serial));
    if (!response) {
      throw new Error(
        `Unexpected fake ADB call: ${this.key(args, options.serial)}`,
      );
    }
    return {
      argv: [...args],
      stdout: response.stdout,
      stderr: response.stderr,
      exitCode: response.exitCode,
      durationMs: 1,
    };
  }

  override async text(
    args: readonly string[],
    options: RunOptions = {},
  ): Promise<string> {
    return (await this.run(args, options)).stdout.toString("utf8").trim();
  }

  override operationId(): string {
    return `test-operation-${this.#nextOperation++}`;
  }

  private key(args: readonly string[], serial?: string): string {
    return `${serial ?? "-"}|${args.join("\u0000")}`;
  }
}

export const DEVICE_LIST =
  "List of devices attached\nserial-1 device product:test model:Test_Device device:test transport_id:1\n";

export function addConnectedDevice(runner: FakeAdbRunner): FakeAdbRunner {
  return runner
    .respond(["devices", "-l"], DEVICE_LIST)
    .respond(["get-state"], "device", { serial: "serial-1" })
    .respond(["shell", "getprop", "ro.serialno"], "TESTHW", {
      serial: "serial-1",
    });
}
