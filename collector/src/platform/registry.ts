/**
 * Registry / App Paths / AppX probes for flavor detection (docs/15 §3.1).
 *
 * Implemented with the built-in `reg.exe` and PowerShell `Get-AppxPackage` so no
 * native registry dependency is required. Windows-only: `assertWindows` guards every
 * export; on Linux these throw WindowsOnlyError and detect.ts treats the flavor as
 * absent (the collector then has no COM tap, exactly as on a New-Outlook-only box).
 */

import { assertWindows, powershell, run } from "./native.js";
import { log } from "../log.js";

/** True if an AppX package with the given family/name prefix is installed (New Outlook). */
export async function isAppxInstalled(packageName: string): Promise<boolean> {
  assertWindows("AppX detection");
  try {
    // Non-empty output => installed. `-ErrorAction SilentlyContinue` keeps it quiet.
    const out = await powershell(
      `(Get-AppxPackage -Name '${packageName}' -ErrorAction SilentlyContinue | Select-Object -First 1).PackageFullName`,
    );
    return out.trim().length > 0;
  } catch (err) {
    log.debug("AppX probe failed", { packageName, err: String(err) });
    return false;
  }
}

/** True if a registry key exists under HKLM/HKCU. `hive` is "HKLM" | "HKCU". */
export async function registryKeyExists(hive: "HKLM" | "HKCU", subKey: string): Promise<boolean> {
  assertWindows("registry access");
  try {
    // `reg query` exits 0 if the key exists, non-zero otherwise (=> run() rejects).
    await run("reg.exe", ["query", `${hive}\\${subKey}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the first present Classic-Outlook version subkey under
 * HKCU\Software\Microsoft\Office\<version>\Outlook (docs/15 §3.1 uses `<version>`).
 * 2016/2019/2021/365 all report version "16.0". Returns the matched version or null.
 */
export async function classicOutlookVersionKey(): Promise<string | null> {
  assertWindows("registry access");
  for (const version of ["16.0", "15.0", "14.0"]) {
    if (
      await registryKeyExists("HKCU", `Software\\Microsoft\\Office\\${version}\\Outlook`)
    ) {
      return version;
    }
  }
  return null;
}
