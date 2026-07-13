/**
 * Structured logging (docs/15 §8.1: logs NEVER contain secrets/tokens).
 *
 * Line-delimited JSON to stdout and a daily-rotated file under logDir(). A hard
 * redaction pass strips anything that looks like a bearer token, refresh token,
 * password, or authorization header before a record is ever written — the collector
 * only ever holds opaque DPAPI account references, but this is defence in depth.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { logDir } from "./config.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Keys whose values are always redacted, regardless of nesting. */
const SECRET_KEYS =
  /^(?:.*_)?(token|refresh|access_token|refreshtoken|password|passwd|secret|authorization|auth|client_secret|app_password|entropy)$/i;

/** Value patterns that look like credentials even under an innocuous key. */
const SECRET_VALUE = /\b(?:Bearer\s+[A-Za-z0-9._-]+|eyJ[A-Za-z0-9._-]{20,}|1\/[A-Za-z0-9._-]{20,})\b/;

function redact(value: unknown, key?: string): unknown {
  if (key && SECRET_KEYS.test(key)) return "[redacted]";
  if (typeof value === "string") return SECRET_VALUE.test(value) ? "[redacted]" : value;
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redact(v, k);
    return out;
  }
  return value;
}

function dayStamp(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

const MIN_LEVEL: LogLevel = (process.env.PID_LOG_LEVEL as LogLevel) ?? "info";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[MIN_LEVEL]) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
  };
  const line = JSON.stringify(record);
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
  try {
    appendFileSync(join(logDir(), `collector-${dayStamp()}.log`), line + "\n");
  } catch {
    /* logging must never throw */
  }
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
  /** Bind a stable set of fields (e.g. accountId) onto a child logger. */
  child(base: Record<string, unknown>) {
    return {
      debug: (m: string, f?: Record<string, unknown>) => write("debug", m, { ...base, ...f }),
      info: (m: string, f?: Record<string, unknown>) => write("info", m, { ...base, ...f }),
      warn: (m: string, f?: Record<string, unknown>) => write("warn", m, { ...base, ...f }),
      error: (m: string, f?: Record<string, unknown>) => write("error", m, { ...base, ...f }),
    };
  },
};

export type Logger = typeof log;
