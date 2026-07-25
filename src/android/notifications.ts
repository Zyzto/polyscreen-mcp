/**
 * Android notifications via `cmd notification` (list / get / post).
 * Keys look like: userId|package|id|tag|uid
 */

/** Package segment in a notification key (allows system pkg `android`). */
const SAFE_KEY_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;
const SAFE_NOTIF_TAG = /^[A-Za-z0-9_./-]{1,128}$/;
const SAFE_NOTIF_KEY =
  /^-?\d+\|[A-Za-z][A-Za-z0-9_.]*\|-?\d+\|[A-Za-z0-9_./-]*\|-?\d+$/;

export interface NotificationRef {
  key: string;
  userId: number;
  packageName: string;
  id: number;
  tag: string | null;
  uid: number;
}

export interface NotificationDetails extends NotificationRef {
  importance?: number;
  channelId?: string;
  title?: string;
  text?: string;
  subText?: string;
  tickerText?: string;
  whenMs?: number;
  seen?: boolean;
  raw: string;
}

export function assertSafeNotificationPackage(packageName: string): string {
  if (!SAFE_KEY_PACKAGE.test(packageName)) {
    throw new Error(`Invalid package: ${packageName}`);
  }
  return packageName;
}

export function assertSafeNotificationTag(tag: string): string {
  if (!SAFE_NOTIF_TAG.test(tag)) {
    throw new Error(
      `Invalid notification tag (use [A-Za-z0-9_./-]{1,128}): ${tag}`,
    );
  }
  return tag;
}

export function assertSafeNotificationKey(key: string): string {
  const trimmed = key.trim();
  if (!SAFE_NOTIF_KEY.test(trimmed)) {
    throw new Error(`Invalid notification key: ${key}`);
  }
  return trimmed;
}

export function assertSafeNotificationText(
  value: string,
  label: string,
  maxLen = 2000,
): string {
  if (value.includes("\0")) {
    throw new Error(`${label} cannot contain NUL bytes`);
  }
  if (value.length === 0 || value.length > maxLen) {
    throw new Error(`${label} length must be 1..${maxLen}`);
  }
  return value;
}

export function parseNotificationKey(key: string): NotificationRef | undefined {
  const trimmed = key.trim();
  if (!SAFE_NOTIF_KEY.test(trimmed)) return undefined;
  const [userIdRaw, packageName, idRaw, tagRaw, uidRaw] = trimmed.split("|");
  if (!packageName || !SAFE_KEY_PACKAGE.test(packageName)) return undefined;
  const userId = Number(userIdRaw);
  const id = Number(idRaw);
  const uid = Number(uidRaw);
  if (![userId, id, uid].every((n) => Number.isInteger(n))) return undefined;
  return {
    key: trimmed,
    userId,
    packageName,
    id,
    tag: tagRaw === "null" || tagRaw === "" ? null : (tagRaw ?? null),
    uid,
  };
}

export function parseNotificationList(raw: string): NotificationRef[] {
  const seen = new Set<string>();
  const items: NotificationRef[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const ref = parseNotificationKey(line);
    if (!ref || seen.has(ref.key)) continue;
    seen.add(ref.key);
    items.push(ref);
  }
  return items;
}

function extractExtrasString(raw: string, key: string): string | undefined {
  const escaped = key.replaceAll(".", "\\.");
  const withValue = raw.match(
    new RegExp(`${escaped}=String\\s+\\(([^)]*)\\)`),
  )?.[1];
  if (withValue !== undefined) return withValue;
  // Redacted dumpsys form: android.title=String [length=28]
  if (new RegExp(`${escaped}=String\\s+\\[length=`).test(raw)) return undefined;
  return undefined;
}

export function parseNotificationRecord(raw: string): NotificationDetails {
  const key =
    raw.match(/\bkey=([^\s:]+)/)?.[1] ??
    raw.match(/\bkey=([^\n]+?)(?::\s*Notification|\s*$)/m)?.[1];
  const ref = key ? parseNotificationKey(key.trim()) : undefined;
  if (!ref) {
    throw new Error("Could not parse notification key from record");
  }

  const importance = Number(
    raw.match(/\bimportance=(\d+)\b/)?.[1] ?? Number.NaN,
  );
  const channelId =
    raw.match(/\bchannel=([^\s)]+)/)?.[1] ??
    raw.match(/mId='([^']+)'/)?.[1] ??
    undefined;
  const whenMs = Number(raw.match(/^\s*when=(\d+)\s*$/m)?.[1]);
  const seenMatch = raw.match(/^\s*seen=(true|false)\s*$/m)?.[1];
  const tickerRaw = raw.match(/^\s*tickerText=(.+)\s*$/m)?.[1]?.trim();
  const tickerText = tickerRaw && tickerRaw !== "null" ? tickerRaw : undefined;
  const title = extractExtrasString(raw, "android.title");
  const text = extractExtrasString(raw, "android.text");
  const subText = extractExtrasString(raw, "android.subText");

  return {
    ...ref,
    ...(Number.isInteger(importance) ? { importance } : {}),
    ...(channelId ? { channelId } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(subText !== undefined ? { subText } : {}),
    ...(tickerText ? { tickerText } : {}),
    ...(Number.isFinite(whenMs) ? { whenMs } : {}),
    ...(seenMatch ? { seen: seenMatch === "true" } : {}),
    raw: raw.slice(0, 50_000),
  };
}
