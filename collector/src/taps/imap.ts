/**
 * IMAP tap via imapflow (docs/15 §3.4, §5.1, §6.4).
 *
 * Cursor is `UIDVALIDITY + UID + MODSEQ` (docs/15 §5.3 cursor_type
 * 'uidvalidity_uid_modseq'). A UIDVALIDITY change invalidates all stored UIDs for the
 * folder and forces a resync (docs/15 §5.1). CONDSTORE (`MODSEQ` + `changedSince`)
 * drives incremental reconciliation; `IDLE` provides push (re-issued near the RFC 2177
 * ~29-min server timeout, docs/15 §6.4). Message-ID is the canonical cross-tap key
 * (docs/15 §5.2). Auth is XOAUTH2 or app password, resolved at connect time — never
 * from New Outlook's cache (docs/15 §8.3).
 */

import { ImapFlow, type FetchMessageObject } from "imapflow";
import type { ClassifiedAccount } from "../model.js";
import { TapKind } from "../model.js";
import { getImapCredentials } from "../auth/imap-oauth.js";
import { contentHashFallback } from "../staging/dedupe.js";
import { log } from "../log.js";
import type { NormalizedItem, TapItemBatch } from "./types.js";

interface ImapCursor {
  uidvalidity: string; // stringified bigint
  uid: number;
  modseq: string; // stringified bigint
}

function parseCursor(cursor: string | null): ImapCursor | null {
  if (!cursor) return null;
  try {
    return JSON.parse(cursor) as ImapCursor;
  } catch {
    return null;
  }
}

async function connect(account: ClassifiedAccount): Promise<ImapFlow> {
  const creds = await getImapCredentials(account);
  if (creds.kind === "none") throw new Error(creds.error);
  const host = account.imapHost ?? account.serverHost ?? "imap.gmail.com";
  const port = account.imapPort ?? 993;
  const auth =
    creds.kind === "oauth"
      ? { user: creds.user, accessToken: creds.accessToken }
      : { user: creds.user, pass: creds.pass };
  const client = new ImapFlow({ host, port, secure: port === 993, auth, logger: false });
  await client.connect();
  return client;
}

/**
 * One mail sync round. `cursor` null => backfill (UID 1:*), else incremental via
 * `changedSince` MODSEQ. Returns a batch and the next cursor to persist after commit.
 */
export async function syncMail(
  account: ClassifiedAccount,
  cursor: string | null,
  opts: { limit?: number } = {},
): Promise<TapItemBatch> {
  const limit = opts.limit ?? 500;
  const prev = parseCursor(cursor);
  const client = await connect(account);
  const items: NormalizedItem[] = [];
  let nextCursor: ImapCursor;
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const mailbox = client.mailbox;
      if (!mailbox || typeof mailbox === "boolean") throw new Error("INBOX not selectable");
      const uidvalidity = String(mailbox.uidValidity);
      const highestModseq = String(mailbox.highestModseq ?? "0");

      // UIDVALIDITY change => stored UIDs are invalid; force a full folder resync.
      const validityChanged = prev !== null && prev.uidvalidity !== uidvalidity;
      const doBackfill = prev === null || validityChanged;
      if (validityChanged) {
        log.warn("UIDVALIDITY changed; resyncing folder", { account: account.address });
      }

      let maxUid = doBackfill ? 0 : prev!.uid;
      const range = doBackfill ? "1:*" : `${prev!.uid + 1}:*`;
      const fetchOpts = doBackfill
        ? { envelope: true, headers: ["message-id"], uid: true, flags: true, internalDate: true }
        : {
            envelope: true,
            headers: ["message-id"],
            uid: true,
            flags: true,
            internalDate: true,
            changedSince: BigInt(prev!.modseq || "0"),
          };

      let count = 0;
      for await (const msg of client.fetch(range, fetchOpts, { uid: true })) {
        items.push(mapImapMessage(account, msg, uidvalidity));
        if (msg.uid > maxUid) maxUid = msg.uid;
        if (++count >= limit) break;
      }
      nextCursor = { uidvalidity, uid: maxUid, modseq: highestModseq };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }

  return {
    items,
    nextCursor: JSON.stringify(nextCursor),
    hasMore: items.length >= limit,
    cursorType: "uidvalidity_uid_modseq",
  };
}

function mapImapMessage(
  account: ClassifiedAccount,
  msg: FetchMessageObject,
  uidvalidity: string,
): NormalizedItem {
  const env = msg.envelope;
  const messageId = env?.messageId ?? headerMessageId(msg);
  const from = env?.from?.[0];
  const fromAddress = from ? `${from.address ?? ""}` : null;
  const occurredAt = env?.date
    ? new Date(env.date).getTime()
    : msg.internalDate
      ? new Date(msg.internalDate).getTime()
      : undefined;
  const item: NormalizedItem = {
    type: "email",
    externalId: `${uidvalidity}:${msg.uid}`,
    tap: TapKind.IMAP,
    title: env?.subject ?? "",
    body: "",
    bodyFormat: "text",
    occurredAt,
    rawIdentifiers: {
      uidvalidity,
      uid: msg.uid,
      modseq: msg.modseq ? String(msg.modseq) : null,
    },
    domainFields: {
      message_id: messageId ?? `${uidvalidity}:${msg.uid}`,
      from_address: fromAddress,
      from_name: from?.name ?? null,
      to_addresses: (env?.to ?? []).map((t) => t.address).filter(Boolean),
      folder: "INBOX",
      is_read: msg.flags?.has("\\Seen") ?? false,
    },
  };
  // canonicalKey: Message-ID primary, content-hash fallback (docs/15 §5.2).
  item.canonicalKey =
    messageId ??
    contentHashFallback({
      from: fromAddress ?? "",
      to: (env?.to ?? []).map((t) => t.address ?? "").join(","),
      subject: env?.subject ?? "",
      sentAt: occurredAt ?? 0,
      body: item.body ?? "",
    });
  return item;
}

function headerMessageId(msg: FetchMessageObject): string | null {
  const raw = msg.headers?.toString?.() ?? "";
  const m = /message-id:\s*(<[^>]+>)/i.exec(raw);
  return m ? m[1]! : null;
}

/**
 * Enter IDLE and resolve when the server signals new mail (or the ~29-min timeout).
 * The incremental engine then re-runs `syncMail` to reconcile via MODSEQ. imapflow
 * manages the periodic IDLE re-issue internally.
 */
export async function idleOnce(account: ClassifiedAccount, timeoutMs = 29 * 60_000): Promise<void> {
  const client = await connect(account);
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          client.on("exists", () => resolve());
        }),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}
