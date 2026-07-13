/**
 * Scheduled Task install / uninstall (docs/15 §6.1, docs/12 "Installing the Outlook
 * Collector").
 *
 * Registers the per-user, "At log on" Scheduled Task from task.xml via `schtasks.exe
 * /Create /XML`, substituting the current node path, the built entrypoint, and the
 * logged-on user. The XML pins every locked setting: LogonTrigger for the specific
 * user, LeastPrivilege (no "highest privileges" => no UAC prompt each logon),
 * InteractiveToken (NOT "run whether logged on or not" => keeps the interactive
 * desktop COM/MAPI needs), and RestartOnFailure 3x1min. NEVER a SYSTEM service
 * (docs/15 §6.3 / §9). Windows-only.
 *
 * Usage:  tsx src/schedule/install.ts install | uninstall
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { IS_WINDOWS } from "../config.js";
import { run } from "../platform/native.js";
import { log } from "../log.js";

const TASK_NAME = "\\PID\\OutlookCollector";
const __dirname = dirname(fileURLToPath(import.meta.url));

function currentUserId(): string {
  const domain = process.env.USERDOMAIN ?? process.env.COMPUTERNAME ?? "";
  const user = process.env.USERNAME ?? "";
  return domain ? `${domain}\\${user}` : user;
}

/** Path to the built entrypoint (dist/index.js) relative to this compiled file. */
function entrypointPath(): string {
  // Compiled layout: dist/schedule/install.js -> dist/index.js
  return resolve(__dirname, "..", "index.js");
}

function renderTaskXml(): string {
  const templatePath = join(__dirname, "task.xml");
  const template = readFileSync(templatePath, "utf8");
  return template
    .replaceAll("{{USER_ID}}", currentUserId())
    .replaceAll("{{COMMAND}}", process.execPath) // node.exe
    .replaceAll("{{ARGUMENTS}}", `"${entrypointPath()}"`)
    .replaceAll("{{WORKDIR}}", resolve(__dirname, "..", ".."))
    .replaceAll("{{DATE}}", new Date().toISOString());
}

export async function install(): Promise<void> {
  if (!IS_WINDOWS) {
    throw new Error("install-task is Windows-only (schtasks.exe). Run this on the target machine.");
  }
  const xml = renderTaskXml();
  // schtasks reads the XML as UTF-16; write with a BOM to be safe.
  const xmlPath = join(tmpdir(), "pid-outlook-collector-task.xml");
  writeFileSync(xmlPath, "﻿" + xml, { encoding: "utf16le" });
  await run("schtasks.exe", ["/Create", "/TN", TASK_NAME, "/XML", xmlPath, "/F"]);
  log.info("Scheduled Task installed", { task: TASK_NAME, user: currentUserId() });
  // Kick it off now so the user doesn't have to log off/on first.
  try {
    await run("schtasks.exe", ["/Run", "/TN", TASK_NAME]);
  } catch (err) {
    log.warn("task created but immediate run failed (will start at next logon)", { err: String(err) });
  }
}

export async function uninstall(): Promise<void> {
  if (!IS_WINDOWS) {
    throw new Error("uninstall-task is Windows-only (schtasks.exe).");
  }
  try {
    await run("schtasks.exe", ["/End", "/TN", TASK_NAME]);
  } catch {
    /* not running */
  }
  await run("schtasks.exe", ["/Delete", "/TN", TASK_NAME, "/F"]);
  log.info("Scheduled Task removed", { task: TASK_NAME });
}

// CLI entry.
const action = process.argv[2];
if (action === "install" || action === "uninstall") {
  const fn = action === "install" ? install : uninstall;
  fn().catch((err) => {
    log.error("schedule command failed", { action, err: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  });
} else if (action) {
  log.error("unknown schedule command; use 'install' or 'uninstall'", { action });
  process.exitCode = 1;
}
