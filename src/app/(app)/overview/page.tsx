"use client";

import { useEffect, useState } from "react";
import { AlarmClock, CalendarClock, CalendarDays, Flame } from "lucide-react";
import { PageHeader } from "@/components/shell/PageHeader";
import { AgendaTimeline, type AgendaEvent } from "@/components/pid/AgendaTimeline";
import { BriefingCard } from "@/components/pid/BriefingCard";
import { DeadlineList, type DeadlineTask } from "@/components/pid/DeadlineList";
import { StatTile } from "@/components/pid/StatTile";

interface Stats {
  dueToday: number;
  overdue: number;
  eventsToday: number;
  upcomingWeek: number;
}

export default function OverviewPage() {
  const [agenda, setAgenda] = useState<AgendaEvent[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [deadlines, setDeadlines] = useState<DeadlineTask[]>([]);

  useEffect(() => {
    fetch("/api/overview/agenda", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { agenda: AgendaEvent[]; stats: Stats }) => {
        setAgenda(d.agenda);
        setStats(d.stats);
      })
      .catch(() => undefined);
    fetch("/api/overview/deadlines", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { deadlines: DeadlineTask[] }) => setDeadlines(d.deadlines))
      .catch(() => undefined);
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Executive Overview"
        description="What's urgent, what's coming up, and today's AI briefing."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Due today"
          value={stats?.dueToday ?? 0}
          icon={AlarmClock}
          tone={stats && stats.dueToday > 0 ? "warning" : "default"}
        />
        <StatTile
          label="Overdue"
          value={stats?.overdue ?? 0}
          icon={Flame}
          tone={stats && stats.overdue > 0 ? "danger" : "default"}
        />
        <StatTile label="Events today" value={stats?.eventsToday ?? 0} icon={CalendarClock} />
        <StatTile label="Upcoming this week" value={stats?.upcomingWeek ?? 0} icon={CalendarDays} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <BriefingCard />
        <div className="space-y-6">
          <AgendaTimeline events={agenda} />
          <DeadlineList deadlines={deadlines} />
        </div>
      </div>
    </div>
  );
}
