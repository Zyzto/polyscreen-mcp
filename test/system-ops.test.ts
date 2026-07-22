import { describe, expect, it } from "vitest";

import { parseActivityTops } from "../src/android/system-ops.js";

describe("parseActivityTops", () => {
  it("extracts package, activity, displayId, and taskId", () => {
    const tops = parseActivityTops(`
      mResumedActivity: ActivityRecord{abc u0 com.example/.MainActivity t12} displayId=4
      topResumedActivity=ActivityRecord{def u0 com.game/.PlayActivity} t3 displayId=0
    `);
    expect(tops).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          packageName: "com.example",
          activity: "com.example/.MainActivity",
          displayId: 4,
          taskId: 12,
        }),
        expect.objectContaining({
          packageName: "com.game",
          activity: "com.game/.PlayActivity",
          displayId: 0,
          taskId: 3,
        }),
      ]),
    );
  });

  it("inherits displayId from Display #N section headers", () => {
    const tops = parseActivityTops(`
      Display #4 (type=EXTERNAL):
        mResumedActivity: ActivityRecord{abc u0 com.example/.MainActivity t12}
      Display #0 (type=INTERNAL):
        mResumedActivity: ActivityRecord{def u0 com.game/.PlayActivity t3}
    `);
    expect(tops).toEqual([
      expect.objectContaining({
        packageName: "com.example",
        displayId: 4,
        taskId: 12,
      }),
      expect.objectContaining({
        packageName: "com.game",
        displayId: 0,
        taskId: 3,
      }),
    ]);
  });

  it("does not inherit Display #N after a top-level section ends", () => {
    const tops = parseActivityTops(`
      Display #4 (type=EXTERNAL):
        mResumedActivity: ActivityRecord{abc u0 com.example/.MainActivity t12}
ACTIVITY MANAGER ACTIVITIES
  mResumedActivity: ActivityRecord{def u0 com.game/.PlayActivity t3}
    `);
    expect(tops[0]).toMatchObject({ packageName: "com.example", displayId: 4 });
    expect(tops[1]).toMatchObject({ packageName: "com.game" });
    expect(tops[1]?.displayId).toBeUndefined();
  });
});
