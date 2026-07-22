import { execFileSync } from "node:child_process";

let cached: boolean | undefined;

/** True when both ffmpeg and ffprobe are on PATH (required for analyze fixtures). */
export function hasFfmpegTools(): boolean {
  if (cached !== undefined) return cached;
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    cached = true;
  } catch {
    cached = false;
  }
  return cached;
}
