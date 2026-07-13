/** Small shared formatters for the PID feature UI. */

export function fmtDate(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function fmtDateTime(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtTime(ms: number | null | undefined): string {
  if (ms == null) return "";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function fmtRelative(ms: number | null | undefined): string {
  if (ms == null) return "never";
  const diff = Date.now() - ms;
  const abs = Math.abs(diff);
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  const suffix = diff >= 0 ? "ago" : "from now";
  if (abs < min) return "just now";
  if (abs < hr) return `${Math.round(abs / min)}m ${suffix}`;
  if (abs < day) return `${Math.round(abs / hr)}h ${suffix}`;
  return `${Math.round(abs / day)}d ${suffix}`;
}

/** Convert a `<input type="date">` value (yyyy-mm-dd) to epoch ms, or null. */
export function dateInputToMs(v: string): number | null {
  if (!v) return null;
  const d = new Date(`${v}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** Convert epoch ms to a `<input type="date">` value (yyyy-mm-dd), or "". */
export function msToDateInput(ms: number | null | undefined): string {
  if (ms == null) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
