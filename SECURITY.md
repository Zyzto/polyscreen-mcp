# Security policy

## Reporting

Do not open a public issue for a vulnerability that could execute host commands, control an unintended Android device, escape path restrictions, bypass MCP transport authentication, or expose sensitive device artifacts. Report it privately to the repository maintainers.

Include the affected version, Android/ADB versions, device build fingerprint, reproduction steps, and the smallest safe proof of impact.

## Trust model

Better Mobile MCP controls devices already authorized to the host's ADB server. Anyone who can invoke mutation tools can interact with those devices within the advertised tool scopes.

Recommended deployment:

- run the server locally through stdio;
- keep ADB bound to its default local endpoint;
- use patched Android devices and current platform tools;
- enable only required tool profiles;
- require MCP client confirmation for destructive or privileged tools;
- treat screenshots, logs, bugreports, traces, and pulled files as sensitive;
- never expose wireless ADB or the MCP server directly to an untrusted network.

## Explicit non-goals

The normal server does not expose:

- unrestricted shell execution;
- `adb root`, remount, verity, SELinux, bootloader, recovery, or partition control;
- arbitrary app-private or system file extraction;
- lock-screen, credential, account, keystore, or device-policy manipulation;
- system-process kill/crash/hang operations.

The instrumentation companion is authenticated with a random per-session token, listens only on an Android local-abstract socket, and is reached through a session-owned ADB forward. It must release held input state on disconnect and shutdown.
