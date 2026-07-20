import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifacts/store.js";

describe("ArtifactStore", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("stores, lists, and reads binary artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "polyscreen-artifacts-"));
    roots.push(root);
    const store = new ArtifactStore(root);

    const saved = await store.save(Buffer.from("png"), ".png", "display-4");
    const listed = await store.list();
    const read = await store.read(saved.name);

    expect(saved.uri).toMatch(/^mobile:\/\/artifacts\//);
    expect(saved.mimeType).toBe("image/png");
    expect(listed).toHaveLength(1);
    expect(read.data.toString()).toBe("png");
  });

  it("rejects path traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "polyscreen-artifacts-"));
    roots.push(root);
    const store = new ArtifactStore(root);
    await expect(store.read("../secret")).rejects.toThrow(
      "Invalid artifact name",
    );
  });
});
