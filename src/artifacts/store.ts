import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, extname, join } from "node:path";

const SAMPLE_DIR = /-samples$/i;

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

export interface PruneOptions {
  maxAgeMs?: number | undefined;
  maxCount?: number | undefined;
  dryRun?: boolean | undefined;
}

export interface PruneResult {
  deleted: string[];
  retained: number;
  dryRun: boolean;
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

  /**
   * Metadata-only listing of regular files. Directories (e.g. sample folders)
   * are omitted so MCP resource lists stay small stubs.
   */
  async list(limit = 1_000): Promise<ArtifactMetadata[]> {
    await mkdir(this.root, { recursive: true });
    const names = await readdir(this.root);
    const artifacts = (
      await Promise.all(
        names.map(async (name) => {
          try {
            const safe = this.safeName(name);
            const details = await stat(join(this.root, safe));
            if (!details.isFile()) return undefined;
            return await this.metadata(safe, details);
          } catch {
            return undefined;
          }
        }),
      )
    ).filter(
      (artifact): artifact is ArtifactMetadata => artifact !== undefined,
    );
    return artifacts
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
      .slice(0, Math.max(1, Math.min(5_000, limit)));
  }

  uriFor(name: string): string {
    return `mobile://artifacts/${encodeURIComponent(this.safeName(name))}`;
  }

  async prune(options: PruneOptions = {}): Promise<PruneResult> {
    const dryRun = options.dryRun ?? false;
    const all = await this.list(5_000);
    const now = Date.now();
    const doomed = new Set<string>();

    if (options.maxAgeMs !== undefined) {
      for (const artifact of all) {
        const age = now - Date.parse(artifact.modifiedAt);
        if (Number.isFinite(age) && age > options.maxAgeMs) {
          doomed.add(artifact.name);
        }
      }
    }

    if (options.maxCount !== undefined && options.maxCount >= 0) {
      const keep = all
        .filter((artifact) => !doomed.has(artifact.name))
        .slice(0, options.maxCount);
      const keepSet = new Set(keep.map((artifact) => artifact.name));
      for (const artifact of all) {
        if (!keepSet.has(artifact.name)) doomed.add(artifact.name);
      }
    }

    const deleted: string[] = [];
    for (const name of doomed) {
      if (!dryRun) {
        await rm(join(this.root, name), { force: true });
      }
      deleted.push(name);
    }

    // Any prune also drops exported sample directories (not listed as file artifacts).
    for (const name of await readdir(this.root)) {
      if (!SAMPLE_DIR.test(name)) continue;
      try {
        const path = join(this.root, name);
        if (!(await stat(path)).isDirectory()) continue;
        if (!dryRun) await rm(path, { recursive: true, force: true });
        deleted.push(`${name}/`);
      } catch {
        // Ignore unreadable entries.
      }
    }

    return {
      deleted: [...new Set(deleted)].sort(),
      retained: all.length - doomed.size,
      dryRun,
    };
  }

  private async metadata(
    name: string,
    details?: Awaited<ReturnType<typeof stat>>,
  ): Promise<ArtifactMetadata> {
    const info = details ?? (await stat(join(this.root, name)));
    const mimeType =
      MIME_TYPES[extname(name).toLocaleLowerCase()] ??
      "application/octet-stream";
    return {
      name,
      uri: this.uriFor(name),
      mimeType,
      sizeBytes: Number(info.size),
      modifiedAt: info.mtime.toISOString(),
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
