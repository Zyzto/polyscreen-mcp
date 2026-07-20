import { z } from "zod";

export const serialSchema = z
  .string()
  .min(1)
  .describe(
    "Exact ADB serial from mobile_devices_list; never inferred when multiple devices exist",
  );

export const displayIdSchema = z
  .number()
  .int()
  .nonnegative()
  .describe(
    "Android framework logical display ID, not a SurfaceFlinger physical ID",
  );

export const packageSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/);

export const pointSchema = z.object({
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
});

export const envelopeOutputSchema = z.object({
  schemaVersion: z.literal("1"),
  operationId: z.string(),
  device: z.object({
    serial: z.string(),
    apiLevel: z.number().optional(),
  }),
  display: z
    .object({
      logicalId: z.number(),
      physicalId: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      rotation: z.number().optional(),
    })
    .optional(),
  backend: z.enum(["adb", "scrcpy", "instrumentation"]),
  data: z.unknown(),
  durationMs: z.number(),
  warnings: z.array(z.string()),
});

export const keyAliases = [
  "DPAD_UP",
  "DPAD_DOWN",
  "DPAD_LEFT",
  "DPAD_RIGHT",
  "DPAD_CENTER",
  "BUTTON_A",
  "BUTTON_B",
  "BUTTON_X",
  "BUTTON_Y",
  "BUTTON_L1",
  "BUTTON_R1",
  "BUTTON_L2",
  "BUTTON_R2",
  "BUTTON_THUMBL",
  "BUTTON_THUMBR",
  "BUTTON_START",
  "BUTTON_SELECT",
  "BUTTON_MODE",
  "BACK",
  "HOME",
  "ENTER",
  "WAKEUP",
  "SLEEP",
] as const;
