export type RiskClass =
  "read" | "app_mutation" | "device_mutation" | "destructive" | "privileged";

export interface AndroidDevice {
  serial: string;
  state: string;
  product?: string;
  model?: string;
  device?: string;
  transportId?: string;
  /** False when a short ADB probe fails (stale mDNS / dropped TCP). */
  reachable?: boolean;
  /** Hardware serial from getprop when probed. */
  hardwareSerial?: string;
  /**
   * Preferred serial for this hardware when duplicates exist
   * (TCP IP:port preferred over adb-tls mDNS names).
   */
  preferredSerial?: string;
  /** True when this entry is the preferred serial for its hardware group. */
  preferred?: boolean;
}

export interface DisplayEvidence {
  source: string;
  confidence: "high" | "medium" | "low";
}

export interface AndroidDisplay {
  logicalId: number;
  physicalId?: string;
  uniqueId?: string;
  name?: string;
  state?: string;
  width?: number;
  height?: number;
  densityDpi?: number;
  rotation?: number;
  focusedWindow?: string;
  focusedActivity?: string;
  focusedPackage?: string;
  focusedTaskId?: number;
  evidence: DisplayEvidence[];
}

export interface InputCapabilities {
  displayTargeting: boolean;
  sources: string[];
  commands: {
    text: boolean;
    keyevent: boolean;
    tap: boolean;
    swipe: boolean;
    dragAndDrop: boolean;
    motionEvent: boolean;
    keyCombination: boolean;
    scroll: boolean;
  };
  keyOptions: {
    longPress: boolean;
    doubleTap: boolean;
    duration: boolean;
    delay: boolean;
    async: boolean;
  };
}

export interface DeviceCapabilities {
  serial: string;
  adbVersion: string;
  apiLevel: number;
  release: string;
  manufacturer: string;
  model: string;
  buildType: string;
  features: string[];
  input: InputCapabilities;
  commands: Record<string, boolean>;
  probedAt: string;
}

export interface CommandResult {
  argv: string[];
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  durationMs: number;
}

export interface OperationEnvelope<T> {
  [key: string]: unknown;
  schemaVersion: "1";
  operationId: string;
  device: {
    serial: string;
    apiLevel?: number;
  };
  display?: {
    logicalId: number;
    physicalId?: string;
    width?: number;
    height?: number;
    rotation?: number;
  };
  backend: "adb" | "scrcpy" | "instrumentation";
  data: T;
  durationMs: number;
  warnings: string[];
}
