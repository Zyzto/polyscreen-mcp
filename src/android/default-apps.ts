/**
 * Android default-app roles via RoleManager (`dumpsys role` / `cmd role`).
 * Short names (home, browser, …) map to `android.app.role.*`.
 */

export const DEFAULT_APP_ROLE_ALIASES = {
  home: "android.app.role.HOME",
  browser: "android.app.role.BROWSER",
  dialer: "android.app.role.DIALER",
  sms: "android.app.role.SMS",
  assistant: "android.app.role.ASSISTANT",
  call_screening: "android.app.role.CALL_SCREENING",
  call_redirection: "android.app.role.CALL_REDIRECTION",
  emergency: "android.app.role.EMERGENCY",
  notes: "android.app.role.NOTES",
  wallet: "android.app.role.WALLET",
  gallery: "android.app.role.SYSTEM_GALLERY",
} as const;

export type DefaultAppRoleAlias = keyof typeof DEFAULT_APP_ROLE_ALIASES;

/** User-facing defaults agents typically care about (excludes most SYSTEM_* roles). */
export const COMMON_DEFAULT_APP_ROLES = [
  DEFAULT_APP_ROLE_ALIASES.home,
  DEFAULT_APP_ROLE_ALIASES.browser,
  DEFAULT_APP_ROLE_ALIASES.dialer,
  DEFAULT_APP_ROLE_ALIASES.sms,
  DEFAULT_APP_ROLE_ALIASES.assistant,
  DEFAULT_APP_ROLE_ALIASES.call_screening,
  DEFAULT_APP_ROLE_ALIASES.call_redirection,
  DEFAULT_APP_ROLE_ALIASES.emergency,
  DEFAULT_APP_ROLE_ALIASES.notes,
  DEFAULT_APP_ROLE_ALIASES.wallet,
  DEFAULT_APP_ROLE_ALIASES.gallery,
] as const;

const SAFE_ROLE = /^android\.app\.role\.[A-Z][A-Z0-9_]*(?:\.[A-Z][A-Z0-9_]*)*$/;
const SAFE_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
const SAFE_COMPONENT =
  /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+\/\.?[A-Za-z][A-Za-z0-9_.$]*$/;

export interface RoleHolders {
  role: string;
  alias?: DefaultAppRoleAlias;
  holders: string[];
}

const ALIAS_BY_ROLE = new Map<string, DefaultAppRoleAlias>(
  (
    Object.entries(DEFAULT_APP_ROLE_ALIASES) as Array<
      [DefaultAppRoleAlias, string]
    >
  ).map(([alias, role]) => [role, alias]),
);

export function resolveRoleName(roleOrAlias: string): string {
  const trimmed = roleOrAlias.trim();
  const lower = trimmed.toLowerCase();
  if (lower in DEFAULT_APP_ROLE_ALIASES) {
    return DEFAULT_APP_ROLE_ALIASES[lower as DefaultAppRoleAlias];
  }
  if (SAFE_ROLE.test(trimmed)) return trimmed;
  throw new Error(
    `Invalid role (use a short name like "home" or a full android.app.role.*): ${roleOrAlias}`,
  );
}

export function assertSafePackage(packageName: string): string {
  if (!SAFE_PACKAGE.test(packageName)) {
    throw new Error(`Invalid package: ${packageName}`);
  }
  return packageName;
}

export function assertSafeComponent(component: string): string {
  if (!SAFE_COMPONENT.test(component)) {
    throw new Error(`Invalid component: ${component}`);
  }
  return component;
}

/**
 * Parse `dumpsys role` output. Format is JSON-ish with bare keys:
 *   user_id=0
 *   name=android.app.role.HOME
 *   holders=com.example.app
 *
 * When `userId` is set, only roles under that user_states block are returned.
 */
export function parseRoleDumpsys(raw: string, userId?: number): RoleHolders[] {
  const roles: RoleHolders[] = [];
  let currentUser: number | undefined;
  let inWantedUser = userId === undefined;
  let currentName: string | undefined;
  let currentHolders: string[] = [];

  const flush = () => {
    if (!currentName || !inWantedUser) {
      currentName = undefined;
      currentHolders = [];
      return;
    }
    const alias = ALIAS_BY_ROLE.get(currentName);
    roles.push({
      role: currentName,
      ...(alias ? { alias } : {}),
      holders: currentHolders,
    });
    currentName = undefined;
    currentHolders = [];
  };

  for (const line of raw.split(/\r?\n/)) {
    const nextUser = line.match(/^\s*user_id=(\d+)\s*$/)?.[1];
    if (nextUser !== undefined) {
      flush();
      currentUser = Number(nextUser);
      inWantedUser = userId === undefined || currentUser === userId;
      continue;
    }
    const name = line.match(
      /^\s*name=(android\.app\.role\.[A-Za-z0-9_.]+)\s*$/,
    )?.[1];
    if (name) {
      flush();
      currentName = name;
      continue;
    }
    const holdersLine = line.match(/^\s*holders=(.+)\s*$/)?.[1];
    if (holdersLine !== undefined && currentName && inWantedUser) {
      currentHolders = holdersLine
        .split(/[,\s]+/)
        .map((part) => part.trim())
        .filter((part) => SAFE_PACKAGE.test(part));
    }
  }
  flush();
  return roles;
}

export function filterRoles(
  roles: RoleHolders[],
  options: {
    roles?: string[] | undefined;
    includeEmpty?: boolean | undefined;
    includeAllSystem?: boolean | undefined;
  } = {},
): RoleHolders[] {
  const wanted = options.roles?.map(resolveRoleName);
  const wantedSet = wanted ? new Set(wanted) : undefined;
  const common = new Set<string>(COMMON_DEFAULT_APP_ROLES);

  return roles.filter((entry) => {
    if (wantedSet) return wantedSet.has(entry.role);
    if (!options.includeAllSystem && !common.has(entry.role)) return false;
    if (!options.includeEmpty && entry.holders.length === 0) return false;
    return true;
  });
}
