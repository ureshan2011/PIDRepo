"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shell/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { dateInputToMs, fmtDate, msToDateInput } from "@/components/pid/format";

type TaskStatus = "open" | "in_progress" | "done" | "cancelled";
type TaskPriority = "low" | "medium" | "high";

interface TaskDTO {
  itemId: string;
  title: string;
  body: string | null;
  status: TaskStatus;
  priority: TaskPriority | null;
  dueAt: number | null;
  completedAt: number | null;
  project: string | null;
  createdAt: number;
  updatedAt: number;
}

const FILTERS = [
  { key: "all", label: "All" },
  { key: "today", label: "Today" },
  { key: "overdue", label: "Overdue" },
  { key: "week", label: "This week" },
  { key: "open", label: "Open" },
  { key: "done", label: "Done" },
] as const;

const NONE = "none";

const STATUS_VARIANT: Record<TaskStatus, "default" | "secondary" | "outline" | "destructive"> = {
  open: "outline",
  in_progress: "default",
  done: "secondary",
  cancelled: "destructive",
};

interface FormState {
  itemId: string | null;
  title: string;
  body: string;
  status: TaskStatus;
  priority: string;
  due: string;
  project: string;
}

const EMPTY_FORM: FormState = {
  itemId: null,
  title: "",
  body: "",
  status: "open",
  priority: NONE,
  due: "",
  project: "",
};

export default function TasksPage() {
  const [filter, setFilter] = useState<string>("all");
  const [tasks, setTasks] = useState<TaskDTO[] | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (f: string) => {
    setTasks(null);
    try {
      const res = await fetch(`/api/tasks?filter=${f}`, { cache: "no-store" });
      const data = (await res.json()) as { tasks: TaskDTO[] };
      setTasks(data.tasks);
    } catch {
      toast.error("Failed to load tasks");
      setTasks([]);
    }
  }, []);

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (t: TaskDTO) => {
    setForm({
      itemId: t.itemId,
      title: t.title,
      body: t.body ?? "",
      status: t.status,
      priority: t.priority ?? NONE,
      due: msToDateInput(t.dueAt),
      project: t.project ?? "",
    });
    setDialogOpen(true);
  };

  const save = async () => {
    if (!form.title.trim()) {
      toast.error("Title is required");
      return;
    }
    setSaving(true);
    const payload = {
      title: form.title.trim(),
      body: form.body.trim() || null,
      status: form.status,
      priority: form.priority === NONE ? null : (form.priority as TaskPriority),
      dueAt: dateInputToMs(form.due),
      project: form.project.trim() || null,
    };
    try {
      const res = await fetch(
        form.itemId ? `/api/tasks/${form.itemId}` : "/api/tasks",
        {
          method: form.itemId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) throw new Error(await res.text());
      toast.success(form.itemId ? "Task updated" : "Task created");
      setDialogOpen(false);
      void load(filter);
    } catch {
      toast.error("Failed to save task");
    } finally {
      setSaving(false);
    }
  };

  const toggleComplete = async (t: TaskDTO) => {
    const next: TaskStatus = t.status === "done" ? "open" : "done";
    try {
      const res = await fetch(`/api/tasks/${t.itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) throw new Error();
      toast.success(next === "done" ? "Task completed" : "Task reopened");
      void load(filter);
    } catch {
      toast.error("Failed to update task");
    }
  };

  const remove = async (t: TaskDTO) => {
    try {
      const res = await fetch(`/api/tasks/${t.itemId}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast.success("Task deleted");
      void load(filter);
    } catch {
      toast.error("Failed to delete task");
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tasks"
        description="Track what needs doing."
        actions={
          <Button onClick={openCreate}>
            <Plus className="mr-1 h-4 w-4" aria-hidden />
            New task
          </Button>
        }
      />

      <Tabs value={filter} onValueChange={setFilter}>
        <TabsList>
          {FILTERS.map((f) => (
            <TabsTrigger key={f.key} value={f.key}>
              {f.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {tasks === null ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : tasks.length === 0 ? (
        <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
          No tasks here. Create one to get started.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10" />
                <TableHead>Title</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Due</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((t) => (
                <TableRow key={t.itemId}>
                  <TableCell>
                    <button
                      onClick={() => toggleComplete(t)}
                      aria-label={t.status === "done" ? "Reopen task" : "Complete task"}
                      className={`flex h-5 w-5 items-center justify-center rounded border ${
                        t.status === "done"
                          ? "border-green-600 bg-green-600 text-white"
                          : "border-input"
                      }`}
                    >
                      {t.status === "done" ? <Check className="h-3.5 w-3.5" aria-hidden /> : null}
                    </button>
                  </TableCell>
                  <TableCell>
                    <div className={t.status === "done" ? "text-muted-foreground line-through" : "font-medium"}>
                      {t.title}
                    </div>
                    {t.project ? (
                      <div className="text-xs text-muted-foreground">{t.project}</div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[t.status]}>{t.status.replace("_", " ")}</Badge>
                  </TableCell>
                  <TableCell>
                    {t.priority ? (
                      <Badge variant="outline">{t.priority}</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {fmtDate(t.dueAt)}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => toggleComplete(t)}>
                        {t.status === "done" ? (
                          <RotateCcw className="h-4 w-4" aria-hidden />
                        ) : (
                          <Check className="h-4 w-4" aria-hidden />
                        )}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openEdit(t)}>
                        <Pencil className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => remove(t)}>
                        <Trash2 className="h-4 w-4 text-red-600" aria-hidden />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{form.itemId ? "Edit task" : "New task"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="task-title">Title</Label>
              <Input
                id="task-title"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="What needs doing?"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="task-body">Details</Label>
              <Textarea
                id="task-body"
                value={form.body}
                onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                rows={3}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Status</Label>
                <Select
                  value={form.status}
                  onValueChange={(v) => setForm((f) => ({ ...f, status: v as TaskStatus }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="open">Open</SelectItem>
                    <SelectItem value="in_progress">In progress</SelectItem>
                    <SelectItem value="done">Done</SelectItem>
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Priority</Label>
                <Select
                  value={form.priority}
                  onValueChange={(v) => setForm((f) => ({ ...f, priority: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>None</SelectItem>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="task-due">Due date</Label>
                <Input
                  id="task-due"
                  type="date"
                  value={form.due}
                  onChange={(e) => setForm((f) => ({ ...f, due: e.target.value }))}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="task-project">Project</Label>
                <Input
                  id="task-project"
                  value={form.project}
                  onChange={(e) => setForm((f) => ({ ...f, project: e.target.value }))}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
