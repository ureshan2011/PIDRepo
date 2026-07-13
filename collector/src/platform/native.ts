/**
 * Shared helpers for the Windows-native platform layer.
 *
 * Every native integration (registry, WAM, Redemption/COM, DPAPI) is reached through
 * a small interface and guarded by `assertWindows()` so a non-Windows run fails loudly
 * with "windows only" instead of crashing deep inside a missing native module. Native
 * modules (winax, win-dpapi) are ALWAYS `await import()`-ed lazily, never statically,
 * so `tsc` and `pnpm install` succeed on Linux where those optionalDependencies are
 * skipped (docs/15: the collector is Windows-only at runtime).
 */

import { execFile } from "node:child_process";
import { IS_WINDOWS } from "../config.js";

export class WindowsOnlyError extends Error {
  constructor(what: string) {
    super(`${what} is available on Windows only`);
    this.name = "WindowsOnlyError";
  }
}

export function assertWindows(what: string): void {
  if (!IS_WINDOWS) throw new WindowsOnlyError(what);
}

/** Run a console tool and resolve its stdout; rejects on non-zero exit. */
export function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: opts.timeoutMs ?? 15_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${cmd} failed: ${stderr || err.message}`));
        else resolve(stdout);
      },
    );
  });
}

/** Run a PowerShell one-liner (used for AppX / DPAPI-shim / WAM probes). */
export function powershell(script: string, timeoutMs = 20_000): Promise<string> {
  return run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { timeoutMs },
  );
}
