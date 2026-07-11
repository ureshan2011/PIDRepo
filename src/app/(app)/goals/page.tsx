"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Circle, Pencil, Plus, Target, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shell/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { dateInputToMs, fmtDate, msToDateInput } from "@/components/pid/format";

type GoalStatus = "active" | "paused" | "completed" | "abandoned";
type MilestoneStatus = "pending" | "in_progress" | "done";

interface MilestoneDTO {
  id: string;
  goalId: string;
  title: string;
  targetDate: number | null;
  completedAt: number | null;
  status: MilestoneStatus;
  sortOrder: number;
}
interface GoalDTO {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  status: GoalStatus;
  targetDate: number | null;
  createdAt: number;
  updatedAt: number;
  milestones: MilestoneDTO[];
  progress: { done: number; total: number; pct: number };
}

interface GoalForm {
  id: string | null;
  title: string;
  description: string;
  category: string;
  status: GoalStatus;
  target: string;
}
const EMPTY_GOAL: GoalForm = {
  id: null,
  title: "",
  description: "",
  category: "",
  status: "active",
  target: "",
};

export default function GoalsPage() {
  const [goals, setGoals] = useState<GoalDTO[] | null>(null);
  const [goalDialog, setGoalDialog] = useState(false);
  const [goalForm, setGoalForm] = useState<GoalForm>(EMPTY_GOAL);
  const [saving, setSaving] = useState(false);
  const [milestoneDrafts, setMilestoneDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setGoals(null);
    try {
      const res = await fetch("/api/goals", { cache: "no-store" });
      const data = (await res.json()) as { goals: GoalDTO[] };
      setGoals(data.goals);
    } catch {
      toast.error("Failed to load goals");
      setGoals([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setGoalForm(EMPTY_GOAL);
    setGoalDialog(true);
  };
  const openEdit = (g: GoalDTO) => {
    setGoalForm({
      id: g.id,
      title: g.title,
      description: g.description ?? "",
      category: g.category ?? "",
      status: g.status,
      target: msToDateInput(g.targetDate),
    });
    setGoalDialog(true);
  };

  const saveGoal = async () => {
    if (!goalForm.title.trim()) {
      toast.error("Title is required");
      return;
    }
    setSaving(true);
    const payload = {
      title: goalForm.title.trim(),
      description: goalForm.description.trim() || null,
      category: goalForm.category.trim() || null,
      status: goalForm.status,
      targetDate: dateInputToMs(goalForm.target),
    };
    try {
      const res = await fetch(goalForm.id ? `/api/goals/${goalForm.id}` : "/api/goals", {
        method: goalForm.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error();
      toast.success(goalForm.id ? "Goal updated" : "Goal created");
      setGoalDialog(false);
      void load();
    } catch {
      toast.error("Failed to save goal");
    } finally {
      setSaving(false);
    }
  };

  const removeGoal = async (g: GoalDTO) => {
    try {
      const res = await fetch(`/api/goals/${g.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast.success("Goal deleted");
      void load();
    } catch {
      toast.error("Failed to delete goal");
    }
  };

  const addMilestone = async (goalId: string) => {
    const title = (milestoneDrafts[goalId] ?? "").trim();
    if (!title) return;
    try {
      const res = await fetch(`/api/goals/${goalId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw new Error();
      setMilestoneDrafts((d) => ({ ...d, [goalId]: "" }));
      void load();
    } catch {
      toast.error("Failed to add milestone");
    }
  };

  const toggleMilestone = async (m: MilestoneDTO) => {
    const next: MilestoneStatus = m.status === "done" ? "pending" : "done";
    try {
      const res = await fetch(`/api/goals/${m.goalId}/milestones/${m.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) throw new Error();
      void load();
    } catch {
      toast.error("Failed to update milestone");
    }
  };

  const removeMilestone = async (m: MilestoneDTO) => {
    try {
      const res = await fetch(`/api/goals/${m.goalId}/milestones/${m.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      void load();
    } catch {
      toast.error("Failed to delete milestone");
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Goals"
        description="Define outcomes and track milestones."
        actions={
          <Button onClick={openCreate}>
            <Plus className="mr-1 h-4 w-4" aria-hidden />
            New goal
          </Button>
        }
      />

      {goals === null ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-56 w-full" />
          ))}
        </div>
      ) : goals.length === 0 ? (
        <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
          No goals yet. Create one and add milestones to track progress.
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {goals.map((g) => (
            <Card key={g.id} className="flex flex-col">
              <CardHeader className="space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="flex items-center gap-2">
                    <Target className="h-5 w-5 text-muted-foreground" aria-hidden />
                    {g.title}
                  </CardTitle>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(g)}>
                      <Pencil className="h-4 w-4" aria-hidden />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => removeGoal(g)}>
                      <Trash2 className="h-4 w-4 text-red-600" aria-hidden />
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={g.status === "completed" ? "secondary" : "default"}>
                    {g.status}
                  </Badge>
                  {g.category ? <Badge variant="outline">{g.category}</Badge> : null}
                  {g.targetDate ? (
                    <span className="text-xs text-muted-foreground">by {fmtDate(g.targetDate)}</span>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-3">
                {g.description ? (
                  <p className="text-sm text-muted-foreground">{g.description}</p>
                ) : null}

                <div>
                  <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      Progress {g.progress.done}/{g.progress.total}
                    </span>
                    <span>{g.progress.pct}%</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{ width: `${g.progress.pct}%` }}
                    />
                  </div>
                </div>

                <ul className="space-y-1">
                  {g.milestones.map((m) => (
                    <li key={m.id} className="flex items-center gap-2 text-sm">
                      <button
                        onClick={() => toggleMilestone(m)}
                        aria-label={m.status === "done" ? "Mark milestone pending" : "Complete milestone"}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        {m.status === "done" ? (
                          <Check className="h-4 w-4 text-green-600" aria-hidden />
                        ) : (
                          <Circle className="h-4 w-4" aria-hidden />
                        )}
                      </button>
                      <span className={m.status === "done" ? "text-muted-foreground line-through" : ""}>
                        {m.title}
                      </span>
                      {m.targetDate ? (
                        <span className="ml-auto text-xs text-muted-foreground">
                          {fmtDate(m.targetDate)}
                        </span>
                      ) : null}
                      <button
                        onClick={() => removeMilestone(m)}
                        aria-label="Delete milestone"
                        className={m.targetDate ? "text-muted-foreground hover:text-red-600" : "ml-auto text-muted-foreground hover:text-red-600"}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>

                <div className="mt-auto flex gap-2 pt-2">
                  <Input
                    value={milestoneDrafts[g.id] ?? ""}
                    onChange={(e) =>
                      setMilestoneDrafts((d) => ({ ...d, [g.id]: e.target.value }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void addMilestone(g.id);
                    }}
                    placeholder="Add a milestone…"
                  />
                  <Button variant="outline" onClick={() => addMilestone(g.id)}>
                    Add
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={goalDialog} onOpenChange={setGoalDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{goalForm.id ? "Edit goal" : "New goal"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="goal-title">Title</Label>
              <Input
                id="goal-title"
                value={goalForm.title}
                onChange={(e) => setGoalForm((f) => ({ ...f, title: e.target.value }))}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="goal-desc">Description</Label>
              <Textarea
                id="goal-desc"
                rows={3}
                value={goalForm.description}
                onChange={(e) => setGoalForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="goal-category">Category</Label>
                <Input
                  id="goal-category"
                  value={goalForm.category}
                  onChange={(e) => setGoalForm((f) => ({ ...f, category: e.target.value }))}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="goal-target">Target date</Label>
                <Input
                  id="goal-target"
                  type="date"
                  value={goalForm.target}
                  onChange={(e) => setGoalForm((f) => ({ ...f, target: e.target.value }))}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGoalDialog(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={saveGoal} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
