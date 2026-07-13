import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Clock,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

/** DB status enum (BUILD_SPEC §9). */
export type HealthStatusDb =
  | "ok"
  | "stale"
  | "auth_failed"
  | "needs_consent"
  | "tap_unavailable";

interface Spec {
  label: string;
  icon: LucideIcon;
  className: string;
}

// Color is ALWAYS paired with an icon + text label — never color-only.
const SPECS: Record<HealthStatusDb, Spec> = {
  ok: {
    label: "OK",
    icon: CheckCircle2,
    className:
      "border-green-600/30 bg-green-600/10 text-green-700 dark:text-green-400",
  },
  stale: {
    label: "STALE",
    icon: Clock,
    className:
      "border-amber-600/30 bg-amber-600/10 text-amber-700 dark:text-amber-400",
  },
  auth_failed: {
    label: "AUTH_FAILED",
    icon: XCircle,
    className: "border-red-600/30 bg-red-600/10 text-red-700 dark:text-red-400",
  },
  needs_consent: {
    label: "NEEDS_CONSENT",
    icon: AlertTriangle,
    className: "border-red-600/30 bg-red-600/10 text-red-700 dark:text-red-400",
  },
  tap_unavailable: {
    label: "TAP_UNAVAILABLE",
    icon: CircleSlash,
    className:
      "border-gray-500/30 bg-gray-500/10 text-gray-600 dark:text-gray-400",
  },
};

/** Status pill pairing color + icon + text for the five-value health enum. */
export function HealthBadge({ status }: { status: HealthStatusDb }) {
  const spec = SPECS[status] ?? SPECS.tap_unavailable;
  const Icon = spec.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-semibold",
        spec.className,
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {spec.label}
    </span>
  );
}
