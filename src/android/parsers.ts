import type {
  AndroidDevice,
  AndroidDisplay,
  InputCapabilities,
} from "./types.js";

const propertyPattern = /\[([^\]]+)\]: \[([^\]]*)\]/g;

export function parseDevices(output: string): AndroidDevice[] {
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial = "", state = "unknown", ...metadata] = line.split(/\s+/);
      const values = Object.fromEntries(
        metadata
          .map((token) => token.split(/:(.*)/s))
          .filter(
            (pair): pair is [string, string] =>
              pair.length >= 2 && pair[1] !== undefined,
          ),
      );
      return {
        serial,
        state,
        ...(values.product ? { product: values.product } : {}),
        ...(values.model ? { model: values.model } : {}),
        ...(values.device ? { device: values.device } : {}),
        ...(values.transport_id ? { transportId: values.transport_id } : {}),
      };
    });
}

export function parseProperties(output: string): Record<string, string> {
  return Object.fromEntries(
    [...output.matchAll(propertyPattern)].map((match) => [match[1], match[2]]),
  );
}

export function parseInputCapabilities(help: string): InputCapabilities {
  const has = (value: string): boolean =>
    new RegExp(`\\b${value}\\b`, "i").test(help);
  return {
    displayTargeting:
      /(?:^|\s)-d(?:\s|,|$)/m.test(help) || /DISPLAY_ID/i.test(help),
    sources: [
      "keyboard",
      "dpad",
      "gamepad",
      "touchscreen",
      "mouse",
      "stylus",
      "trackball",
      "touchpad",
      "touchnavigation",
      "joystick",
      "rotaryencoder",
    ].filter(has),
    commands: {
      text: has("text"),
      keyevent: has("keyevent"),
      tap: has("tap"),
      swipe: has("swipe"),
      dragAndDrop: has("draganddrop"),
      motionEvent: has("motionevent"),
      keyCombination: has("keycombination"),
      scroll: has("scroll"),
    },
    keyOptions: {
      longPress: help.includes("--longpress"),
      doubleTap: help.includes("--doubletap"),
      duration: help.includes("--duration"),
      delay: help.includes("--delay"),
      async: help.includes("--async"),
    },
  };
}

export function parsePhysicalDisplays(output: string): string[] {
  const ids = new Set<string>();
  const maximum = (1n << 64n) - 1n;
  for (const line of output.split(/\r?\n/)) {
    const value = line.match(/^\s*Display\s+(\d+)(?:\s.*)?$/i)?.[1];
    if (!value) continue;
    const id = BigInt(value);
    if (id <= maximum) ids.add(id.toString());
  }
  return [...ids];
}

export function parseLogicalDisplays(output: string): AndroidDisplay[] {
  const displays = new Map<number, AndroidDisplay>();
  const lines = output.split(/\r?\n/);
  let currentId: number | undefined;

  const ensure = (id: number): AndroidDisplay => {
    const existing = displays.get(id);
    if (existing) return existing;
    const display: AndroidDisplay = {
      logicalId: id,
      evidence: [{ source: "dumpsys display", confidence: "high" }],
    };
    displays.set(id, display);
    return display;
  };

  for (const line of lines) {
    const idMatch =
      line.match(/\bmDisplayId=(\d+)/) ??
      line.match(/DisplayInfo.*?\bdisplayId[= ](\d+)/i) ??
      line.match(/^\s*Display\s+(\d+)\b/i);
    if (idMatch?.[1] !== undefined) currentId = Number(idMatch[1]);
    if (currentId === undefined || !line.includes("DisplayInfo{")) continue;

    const display = ensure(currentId);
    const isOverride = line.includes("mOverrideDisplayInfo=");
    const uniqueId =
      line.match(/\buniqueId[= ]["']([^"']+)/i)?.[1] ??
      line.match(/\buniqueId[= ]([^,\s}]+)/i)?.[1];
    const name =
      line.match(/DisplayInfo\{"([^"]+)"/)?.[1] ??
      line.match(/\bname[= ]["']([^"']+)/i)?.[1];
    const state = line.match(/\bstate[= ]([A-Z_]+)/)?.[1];
    const dimensions =
      line.match(/\breal\s+(\d{2,5})\s*x\s*(\d{2,5})\b/i) ??
      (!line.includes("mBaseDisplayInfo") && !isOverride
        ? line.match(/\b(\d{2,5})\s*x\s*(\d{2,5})\b/i)
        : undefined);
    const density =
      line.match(/\bdensityDpi[= ](\d+)/i)?.[1] ??
      line.match(/\bdensity\s+(\d+)\b/i)?.[1];
    const rotation = line.match(/\brotation[= ](\d+)/i)?.[1];

    if (uniqueId) display.uniqueId = uniqueId;
    if (name) display.name = name;
    if (state && !isOverride) display.state = state;
    if (dimensions?.[1] && dimensions[2]) {
      display.width = Number(dimensions[1]);
      display.height = Number(dimensions[2]);
    }
    if (density) display.densityDpi = Number(density);
    if (rotation) display.rotation = Number(rotation);
  }

  return [...displays.values()].sort((a, b) => a.logicalId - b.logicalId);
}

export function correlatePhysicalDisplays(
  logical: AndroidDisplay[],
  physicalIds: string[],
): AndroidDisplay[] {
  const remaining = new Set(physicalIds);
  for (const display of logical) {
    const localId = display.uniqueId?.match(/^local:(\d+)$/)?.[1];
    if (localId && remaining.has(localId)) {
      display.physicalId = localId;
      display.evidence.push({
        source: "DisplayInfo.uniqueId",
        confidence: "high",
      });
      remaining.delete(localId);
    }
  }
  if (logical.length === 1 && remaining.size === 1 && !logical[0]?.physicalId) {
    const only = [...remaining][0];
    if (only && logical[0]) {
      logical[0].physicalId = only;
      logical[0].evidence.push({
        source: "single-display fallback",
        confidence: "medium",
      });
    }
  }
  return logical;
}
