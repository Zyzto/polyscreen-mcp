import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".xml": "application/xml",
  ".json": "application/json",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".mp4": "video/mp4",
  ".zip": "application/zip",
};

export interface ArtifactMetadata {
  name: string;
  uri: string;
  mimeType: string;
  sizeBytes: number;
  modifiedAt: string;
}

export class ArtifactStore {
  constructor(readonly root: string) {}

  async save(
    data: Buffer,
    extension: string,
    prefix: string,
  ): Promise<ArtifactMetadata> {
    await mkdir(this.root, { recursive: true });
    const safeExtension = extension.startsWith(".")
      ? extension
      : `.${extension}`;
    const name = `${prefix}-${Date.now()}-${randomUUID()}${safeExtension}`;
    await writeFile(join(this.root, name), data, { flag: "wx" });
    return await this.metadata(name);
  }

  async read(
    name: string,
  ): Promise<{ metadata: ArtifactMetadata; data: Buffer }> {
    const safeName = this.safeName(name);
    return {
      metadata: await this.metadata(safeName),
      data: await readFile(join(this.root, safeName)),
    };
  }

  async list(): Promise<ArtifactMetadata[]> {
    await mkdir(this.root, { recursive: true });
    const names = await readdir(this.root);
    const artifacts = await Promise.all(
      names.map((name) => this.metadata(this.safeName(name))),
    );
    return artifacts
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
      .slice(0, 1_000);
  }

  private async metadata(name: string): Promise<ArtifactMetadata> {
    const details = await stat(join(this.root, name));
    const mimeType =
      MIME_TYPES[extname(name).toLocaleLowerCase()] ??
      "application/octet-stream";
    return {
      name,
      uri: `mobile://artifacts/${encodeURIComponent(name)}`,
      mimeType,
      sizeBytes: details.size,
      modifiedAt: details.mtime.toISOString(),
    };
  }

  private safeName(name: string): string {
    if (
      name !== basename(name) ||
      name.includes("\0") ||
      name === "." ||
      name === ".."
    ) {
      throw new Error("Invalid artifact name");
    }
    return name;
  }
}
