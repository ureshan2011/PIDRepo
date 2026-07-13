/**
 * Single-instance lock + heartbeat (docs/15 §6.2).
 *
 * Transcribes the pseudocode:
 *   if lock exists and (now - lock.heartbeat_at) < LOCK_STALE_THRESHOLD: exit(0)
 *   writeLockFile({ pid, heartbeat_at: now }); startHeartbeatTimer(30s)
 *
 * We use a lock FILE (equivalent to the named-mutex option the doc offers) so the
 * mechanism is identical on Windows and in dev on other platforms. A crash simply
 * stops refreshing `heartbeat_at`; the next launch sees it go stale after 90s and
 * takes over. On fast user switching / re-logon, a still-fresh lock makes the new
 * instance exit immediately.
 */

import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { lockFilePath, LOCK_STALE_THRESHOLD_MS, HEARTBEAT_INTERVAL_MS } from "./config.js";
import { log } from "./log.js";

interface LockRecord {
  pid: number;
  heartbeat_at: number;
  startedAt: number;
}

function readLock(path: string): LockRecord | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LockRecord;
  } catch {
    return null; // corrupt lock => treat as absent
  }
}

export class SingleInstanceLock {
  private timer: NodeJS.Timeout | null = null;
  private readonly path = lockFilePath();

  /**
   * Returns true if this process acquired the lock and should run the main loop;
   * false if a healthy instance already holds it (caller should exit 0).
   */
  acquire(): boolean {
    const existing = readLock(this.path);
    const now = Date.now();
    if (existing && now - existing.heartbeat_at < LOCK_STALE_THRESHOLD_MS) {
      log.info("another healthy collector instance is running; exiting", {
        heldByPid: existing.pid,
        ageMs: now - existing.heartbeat_at,
      });
      return false;
    }
    if (existing) {
      log.warn("taking over stale lock", {
        stalePid: existing.pid,
        ageMs: now - existing.heartbeat_at,
      });
    }
    this.writeHeartbeat(now, now);
    this.timer = setInterval(() => this.beat(), HEARTBEAT_INTERVAL_MS);
    // Do not keep the event loop alive solely for the heartbeat.
    this.timer.unref?.();
    return true;
  }

  private beat(): void {
    const rec = readLock(this.path);
    // If another instance overwrote our lock (we somehow lost it), stop beating.
    if (rec && rec.pid !== process.pid) {
      log.warn("lost single-instance lock to another pid; stopping heartbeat", { owner: rec.pid });
      this.stop();
      return;
    }
    this.writeHeartbeat(Date.now(), rec?.startedAt ?? Date.now());
  }

  private writeHeartbeat(now: number, startedAt: number): void {
    const rec: LockRecord = { pid: process.pid, heartbeat_at: now, startedAt };
    writeFileSync(this.path, JSON.stringify(rec), "utf8");
  }

  /** Release on clean shutdown. A crash simply skips this — staleness handles it. */
  release(): void {
    this.stop();
    const rec = readLock(this.path);
    if (rec && rec.pid === process.pid) {
      try {
        rmSync(this.path);
      } catch {
        /* best effort */
      }
    }
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
