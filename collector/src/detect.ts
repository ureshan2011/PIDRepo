/**
 * Outlook flavor detection (docs/15 §3.1).
 *
 * Faithful transcription of `detectFlavors()`. Both flavors can be installed at once
 * in 2026 — this makes no exclusivity assumption. On non-Windows the registry/AppX
 * probes throw WindowsOnlyError, caught here so detection yields an empty set (no
 * flavors) rather than crashing — which is also the correct "nothing installed" answer.
 */

import { OutlookFlavor } from "./model.js";
import { isAppxInstalled, registryKeyExists, classicOutlookVersionKey } from "./platform/registry.js";
import { log } from "./log.js";

export async function detectFlavors(): Promise<Set<OutlookFlavor>> {
  const flavors = new Set<OutlookFlavor>();

  // New Outlook (olk.exe): sandboxed WinAppSDK/AppX package, no COM surface.
  try {
    if (await isAppxInstalled("Microsoft.OutlookForWindows")) {
      flavors.add(OutlookFlavor.NEW_OUTLOOK);
    }
  } catch (err) {
    log.debug("New Outlook detection unavailable", { err: String(err) });
  }

  // Classic Outlook (outlook.exe): traditional MSI/C2R install with a MAPI subsystem.
  try {
    const appPath = await registryKeyExists(
      "HKLM",
      "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\OUTLOOK.EXE",
    );
    const profileKey = (await classicOutlookVersionKey()) !== null;
    if (appPath && profileKey) {
      flavors.add(OutlookFlavor.CLASSIC_OUTLOOK);
    }
  } catch (err) {
    log.debug("Classic Outlook detection unavailable", { err: String(err) });
  }

  log.info("detected Outlook flavors", { flavors: [...flavors] });
  return flavors; // may be {}, {NEW_OUTLOOK}, {CLASSIC_OUTLOOK}, or both
}

/** Convenience predicate used across the engines. */
export function hasClassic(flavors: Set<OutlookFlavor>): boolean {
  return flavors.has(OutlookFlavor.CLASSIC_OUTLOOK);
}
