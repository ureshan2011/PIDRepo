import { CalendarClock, MapPin } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { fmtDate, fmtTime } from "./format";

export interface AgendaEvent {
  itemId: string;
  title: string;
  startAt: number;
  endAt: number | null;
  allDay: boolean;
  location: string | null;
  bucket: "today" | "week";
}

/** Upcoming events grouped Today vs This week. */
export function AgendaTimeline({ events }: { events: AgendaEvent[] }) {
  const today = events.filter((e) => e.bucket === "today");
  const week = events.filter((e) => e.bucket === "week");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarClock className="h-5 w-5 text-muted-foreground" aria-hidden />
          Agenda
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No events in the next 7 days.</p>
        ) : (
          <>
            <Group label="Today" events={today} showDate={false} />
            <Group label="This week" events={week} showDate />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Group({
  label,
  events,
  showDate,
}: {
  label: string;
  events: AgendaEvent[];
  showDate: boolean;
}) {
  if (events.length === 0) return null;
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </h3>
      <ul className="space-y-2">
        {events.map((e) => (
          <li key={e.itemId} className="flex items-start gap-3 text-sm">
            <div className="w-24 shrink-0 tabular-nums text-muted-foreground">
              {e.allDay
                ? "All day"
                : showDate
                  ? `${fmtDate(e.startAt)} ${fmtTime(e.startAt)}`
                  : fmtTime(e.startAt)}
            </div>
            <div className="min-w-0">
              <div className="font-medium">{e.title}</div>
              {e.location ? (
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <MapPin className="h-3 w-3" aria-hidden />
                  {e.location}
                </div>
              ) : null}
            </div>
            {e.allDay ? (
              <Badge variant="secondary" className="ml-auto">
                all-day
              </Badge>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
