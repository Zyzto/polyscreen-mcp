import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

export const PACKAGE_VERSION = pkg.version;
export const PACKAGE_NAME = pkg.name;

export const CORE_DETECTIVE_TOOLS = [
  "mobile_server_info",
  "mobile_sessions_status",
  "mobile_record_start",
  "mobile_record_mark",
  "mobile_record_stop",
  "mobile_analyze_recording",
  "mobile_theme_flash_report",
  "mobile_focus_trace",
  "mobile_focus_trace_start",
  "mobile_focus_trace_stop",
  "mobile_screen_capture_pair",
  "mobile_artifacts_list",
  "mobile_artifacts_prune",
  "mobile_app_relaunch_on_displays",
] as const;
