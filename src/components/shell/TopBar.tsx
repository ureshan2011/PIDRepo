"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";

/**
 * App top bar. Polls the LM Studio health endpoint for a low-key reachability
 * indicator (mirrors the ConnectionHealthList "degrade loudly" pattern).
 */
export function TopBar() {
  const [reachable, setReachable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch("/api/health/lm-studio", { cache: "no-store" });
        const data = (await res.json()) as { reachable?: boolean };
        if (!cancelled) setReachable(Boolean(data.reachable));
      } catch {
        if (!cancelled) setReachable(false);
      }
    };
    check();
    const id = setInterval(check, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <header className="flex h-14 items-center justify-between border-b px-4">
      <div className="text-sm font-medium text-muted-foreground md:hidden">PID</div>
      <div className="ml-auto flex items-center gap-3">
        <Badge variant={reachable ? "default" : reachable === null ? "secondary" : "outline"}>
          <span
            className={
              reachable
                ? "mr-1.5 inline-block h-2 w-2 rounded-full bg-green-500"
                : "mr-1.5 inline-block h-2 w-2 rounded-full bg-gray-400"
            }
          />
          LM Studio {reachable ? "online" : reachable === null ? "…" : "offline"}
        </Badge>
      </div>
    </header>
  );
}
