/**
 * Outlook Collector entrypoint (docs/15 §2, §3, §6).
 *
 * Lifecycle: acquire the single-instance lock (§6.2) -> DETECT installed flavors (§3.1)
 * -> ENUMERATE + CLASSIFY accounts (§3.2/§3.3) -> CHOOSE a tap per account (§3.4) ->
 * run BACKFILL once + start INCREMENTAL steady state (§4). Detect/classify/select is
 * re-run every 30 min (and could be re-run on session-unlock) to pick up newly added
 * accounts, an installed/uninstalled flavor, or admin consent finally granted (§3).
 *
 * `--setup` runs the ONE-TIME interactive account/OAuth wizard (the only user-initiated
 * step; everything after is unattended, docs/15 §9). Never a SYSTEM service (§6.3).
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { SingleInstanceLock } from "./lock.js";
import { detectFlavors } from "./detect.js";
import {
  enumerateCandidateAccounts,
  classifyAll,
  loadUserConfiguredAccounts,
  saveUserConfiguredAccounts,
} from "./accounts.js";
import { chooseTap } from "./tap-selector.js";
import { StagingWriter } from "./staging/writer.js";
import { HealthTracker } from "./health.js";
import { BackfillEngine, type EngineContext } from "./engines/backfill.js";
import { IncrementalEngine } from "./engines/incremental.js";
import { runAuthCodePkceLoopback, runDeviceCode } from "./auth/graph-oauth.js";
import { runGoogleOAuthLoopback, storeAppPassword } from "./auth/imap-oauth.js";
import { hasStoredToken } from "./auth/token-store.js";
import { AccountFlavor, TapKind, type ClassifiedAccount } from "./model.js";
import { stagingDbPath, RECLASSIFY_INTERVAL_MS, IS_WINDOWS } from "./config.js";
import { log } from "./log.js";

class Collector {
  private readonly writer: StagingWriter;
  private readonly health: HealthTracker;
  private readonly backfill: BackfillEngine;
  private readonly incremental: IncrementalEngine;
  private readonly backfilled = new Set<string>();
  private ctx: EngineContext;
  private reclassifyTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.writer = new StagingWriter(stagingDbPath());
    this.health = new HealthTracker(this.writer);
    this.ctx = { writer: this.writer, health: this.health, flavors: new Set() };
    this.backfill = new BackfillEngine(this.ctx);
    this.incremental = new IncrementalEngine(this.ctx);
  }

  /** One full detect -> classify -> select -> backfill+incremental pass (docs/15 §3). */
  async pass(): Promise<void> {
    const flavors = await detectFlavors();
    this.ctx.flavors = flavors; // shared with the engines (dual-tap decision)

    const raw = await enumerateCandidateAccounts(flavors);
    const accounts = await classifyAll(raw);
    log.info("collector pass", { flavors: [...flavors], accounts: accounts.length });

    for (const account of accounts) {
      try {
        const decision = await chooseTap(account, flavors);
        this.health.onDecision(account.id, "mail", decision.status, decision.reason);
        if (decision.calendar !== TapKind.NONE || decision.status !== "ok") {
          this.health.onDecision(account.id, "calendar", decision.status, decision.reason);
        }
        if (decision.status !== "ok") {
          // Parked (needs_consent / auth_failed / tap_unavailable) — surfaced, not polled.
          this.incremental.stopLoop(account.id, "mail");
          this.incremental.stopLoop(account.id, "calendar");
          continue;
        }
        // Backfill once per account; steady state starts immediately regardless (§4.2).
        if (!this.backfilled.has(account.id)) {
          this.backfilled.add(account.id);
          void this.backfill.run(account, decision);
        }
        this.incremental.start(account, decision);
      } catch (err) {
        log.error("account pass failed", {
          account: account.address,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  start(): void {
    void this.pass();
    this.reclassifyTimer = setInterval(() => void this.pass(), RECLASSIFY_INTERVAL_MS);
    this.reclassifyTimer.unref?.();
  }

  shutdown(): void {
    if (this.reclassifyTimer) clearInterval(this.reclassifyTimer);
    this.incremental.stopAll();
    this.writer.close();
  }
}

/**
 * One-time interactive setup (docs/15 §9: the ONLY user-initiated step). For each
 * account that needs credentials, runs the matching consent flow and seals the token
 * via DPAPI. Non-secret descriptors are persisted so accounts are never re-prompted.
 */
async function runSetup(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const flavors = await detectFlavors();
    const discovered = await classifyAll(await enumerateCandidateAccounts(flavors));

    // Let the user add a bare IMAP/Gmail account that has no OS-level discovery path.
    const answer = (await rl.question("Add a manual IMAP/Gmail account? [y/N] ")).trim().toLowerCase();
    if (answer === "y") {
      const address = (await rl.question("  Email address: ")).trim();
      const imapHost = (await rl.question("  IMAP host [imap.gmail.com]: ")).trim() || "imap.gmail.com";
      const isGoogle = /gmail\.com$/i.test(imapHost) || /gmail\.com$/i.test(address);
      const stored = loadUserConfiguredAccounts();
      stored.push({
        id: `acct:${address.toLowerCase()}`,
        address,
        accountType: "IMAP",
        imapHost,
        imapPort: 993,
        oauthIssuer: isGoogle ? "accounts.google.com" : undefined,
        authKind: isGoogle ? "oauth" : "app_password",
      });
      saveUserConfiguredAccounts(stored);
      log.info("manual account saved", { address });
    }

    // Re-enumerate to include the just-added account, then consent per flavor.
    const accounts = await classifyAll(await enumerateCandidateAccounts(flavors));
    for (const account of accounts) {
      if (hasStoredToken(account.id)) {
        log.info("account already has sealed credentials; skipping", { account: account.address });
        continue;
      }
      await consentForAccount(account, rl);
    }
    log.info("setup complete — run the collector (or install the Scheduled Task) to sync");
  } finally {
    rl.close();
  }
}

async function consentForAccount(
  account: ClassifiedAccount,
  rl: ReturnType<typeof createInterface>,
): Promise<void> {
  switch (account.flavor) {
    case AccountFlavor.EXO_ORG:
    case AccountFlavor.PERSONAL_MSA:
    case AccountFlavor.ON_PREM_EXCH: {
      log.info("starting Microsoft Graph consent", { account: account.address ?? account.upn });
      const mode = (await rl.question("  Graph sign-in: [b]rowser (default) or [d]evice-code? ")).trim();
      const result = mode.toLowerCase() === "d" ? await runDeviceCode(account) : await runAuthCodePkceLoopback(account);
      log.info("Graph consent result", { account: account.address, ok: result.ok, error: result.error });
      break;
    }
    case AccountFlavor.GMAIL_IMAP: {
      log.info("starting Google OAuth (direct to Google, never via Microsoft)", { account: account.address });
      const result = await runGoogleOAuthLoopback(account);
      if (!result.ok) {
        const appPw = (await rl.question("  OAuth unavailable — paste a Gmail app password: ")).trim();
        if (appPw) await storeAppPassword(account, appPw);
      }
      break;
    }
    case AccountFlavor.OTHER_IMAP: {
      const appPw = (await rl.question(`  App password for ${account.address}: `)).trim();
      if (appPw) await storeAppPassword(account, appPw);
      break;
    }
    case AccountFlavor.POP_PST:
      log.info("POP account reads via Classic Outlook COM — no OAuth needed", { account: account.address });
      break;
  }
}

async function main(): Promise<void> {
  if (!IS_WINDOWS) {
    log.warn("This collector is Windows-only at runtime; native taps (COM/WAM/DPAPI) will error off-Windows.");
  }

  if (process.argv.includes("--setup")) {
    await runSetup();
    return;
  }

  const lock = new SingleInstanceLock();
  if (!lock.acquire()) {
    process.exit(0); // another healthy instance holds the lock (docs/15 §6.2)
  }

  const collector = new Collector();
  const shutdown = (signal: string) => {
    log.info("shutting down", { signal });
    collector.shutdown();
    lock.release();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  collector.start();
  log.info("collector running (per-user, logon-launched)", { stagingDb: stagingDbPath() });
  // Keep the process alive; the engines run on their own timers.
  await new Promise<void>(() => {});
}

main().catch((err) => {
  log.error("fatal", { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
