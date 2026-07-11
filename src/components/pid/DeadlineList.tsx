import { AlarmClock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtDate } from "./format";

export interface DeadlineTask {
  itemId: string;
  title: string;
  status: string;
  priority: string | null;
  dueAt: number | null;
  bucket: "overdue" | "today" | "week";
}

const BUCKET_LABEL: Record<DeadlineTask["bucket"], string> = {
  overdue: "Overdue",
  today: "Due today",
  week: "This week",
};

/** Open task deadlines grouped by urgency bucket. */
export function DeadlineList({ deadlines }: { deadlines: DeadlineTask[] }) {
  const order: DeadlineTask["bucket"][] = ["overdue", "today", "week"];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlarmClock className="h-5 w-5 text-muted-foreground" aria-hidden />
          Deadlines
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {deadlines.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open deadlines in the next 7 days.</p>
        ) : (
          order.map((bucket) => {
            const rows = deadlines.filter((d) => d.bucket === bucket);
            if (rows.length === 0) return null;
            return (
              <div key={bucket}>
                <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {BUCKET_LABEL[bucket]}
                  {bucket === "overdue" ? (
                    <span className="text-red-600 dark:text-red-400">({rows.length})</span>
                  ) : null}
                </h3>
                <ul className="space-y-2">
                  {rows.map((d) => (
                    <li key={d.itemId} className="flex items-center gap-2 text-sm">
                      <span
                        className={
                          bucket === "overdue"
                            ? "font-medium text-red-600 dark:text-red-400"
                            : "font-medium"
                        }
                      >
                        {d.title}
                      </span>
                      {d.priority ? (
                        <Badge variant="outline" className="text-[10px]">
                          {d.priority}
                        </Badge>
                      ) : null}
                      <span className="ml-auto tabular-nums text-xs text-muted-foreground">
                        {fmtDate(d.dueAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
