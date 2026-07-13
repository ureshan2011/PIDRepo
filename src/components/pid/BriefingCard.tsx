"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtTime } from "./format";

interface BriefingItem {
  itemId: string;
  note: string;
}
interface BriefingSection {
  title: string;
  items: BriefingItem[];
}
interface Briefing {
  headline: string;
  sections: BriefingSection[];
  generatedAt: number;
  unavailable: boolean;
  note?: string;
}

/** AI daily briefing surface with manual refresh + LM-Studio-down fallback. */
export function BriefingCard() {
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/overview/briefing", { cache: "no-store" });
      setBriefing((await res.json()) as Briefing);
    } catch {
      setBriefing(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-muted-foreground" aria-hidden />
          Daily Briefing
        </CardTitle>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
          aria-label="Refresh briefing"
        >
          <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} aria-hidden />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && !briefing ? (
          <div className="space-y-2">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        ) : !briefing ? (
          <p className="text-sm text-muted-foreground">Could not load the briefing.</p>
        ) : (
          <>
            {briefing.unavailable ? (
              <div className="flex items-start gap-2 rounded-md border border-amber-600/30 bg-amber-600/10 p-3 text-sm text-amber-800 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>{briefing.note ?? "Briefing unavailable — showing raw highlights."}</span>
              </div>
            ) : null}

            <p className="text-base font-medium">{briefing.headline}</p>

            {briefing.sections.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing to highlight right now.</p>
            ) : (
              <div className="space-y-4">
                {briefing.sections.map((s, i) => (
                  <div key={`${s.title}-${i}`}>
                    <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {s.title}
                    </h3>
                    <ul className="space-y-1">
                      {s.items.map((it, j) => (
                        <li key={`${it.itemId}-${j}`} className="flex gap-2 text-sm">
                          <span aria-hidden className="text-muted-foreground">
                            •
                          </span>
                          <span>{it.note}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              {briefing.unavailable ? "Raw highlights" : "Generated"} at{" "}
              {fmtTime(briefing.generatedAt)}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
