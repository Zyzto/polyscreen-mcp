import { describe, expect, it } from "vitest";

import { DeviceQueue } from "../src/android/device-queue.js";

describe("DeviceQueue", () => {
  it("serializes mutations for one device without blocking another", async () => {
    const queue = new DeviceQueue();
    const events: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.mutate("a", async () => {
      events.push("a1-start");
      await gate;
      events.push("a1-end");
    });
    const second = queue.mutate("a", async () => {
      events.push("a2");
    });
    const other = queue.mutate("b", async () => {
      events.push("b1");
    });

    await other;
    expect(events).toEqual(["a1-start", "b1"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["a1-start", "b1", "a1-end", "a2"]);
  });
});
