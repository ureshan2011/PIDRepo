"use client";

import { useCallback, useEffect, useState } from "react";
import { Pencil, Pin, PinOff, Plus, Trash2 } from "lucide-react";
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
import { fmtRelative } from "@/components/pid/format";

interface NoteDTO {
  itemId: string;
  title: string;
  body: string | null;
  notebook: string | null;
  tags: string[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

interface FormState {
  itemId: string | null;
  title: string;
  body: string;
  notebook: string;
  tags: string;
  pinned: boolean;
}

const EMPTY_FORM: FormState = {
  itemId: null,
  title: "",
  body: "",
  notebook: "",
  tags: "",
  pinned: false,
};

export default function NotesPage() {
  const [notes, setNotes] = useState<NoteDTO[] | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setNotes(null);
    try {
      const res = await fetch("/api/notes", { cache: "no-store" });
      const data = (await res.json()) as { notes: NoteDTO[] };
      setNotes(data.notes);
    } catch {
      toast.error("Failed to load notes");
      setNotes([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (n: NoteDTO) => {
    setForm({
      itemId: n.itemId,
      title: n.title,
      body: n.body ?? "",
      notebook: n.notebook ?? "",
      tags: n.tags.join(", "),
      pinned: n.pinned,
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
      notebook: form.notebook.trim() || null,
      tags: form.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      pinned: form.pinned,
    };
    try {
      const res = await fetch(form.itemId ? `/api/notes/${form.itemId}` : "/api/notes", {
        method: form.itemId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error();
      toast.success(form.itemId ? "Note updated" : "Note created");
      setDialogOpen(false);
      void load();
    } catch {
      toast.error("Failed to save note");
    } finally {
      setSaving(false);
    }
  };

  const togglePin = async (n: NoteDTO) => {
    try {
      const res = await fetch(`/api/notes/${n.itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: !n.pinned }),
      });
      if (!res.ok) throw new Error();
      void load();
    } catch {
      toast.error("Failed to update note");
    }
  };

  const remove = async (n: NoteDTO) => {
    try {
      const res = await fetch(`/api/notes/${n.itemId}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast.success("Note deleted");
      void load();
    } catch {
      toast.error("Failed to delete note");
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notes"
        description="Capture and organize your thoughts."
        actions={
          <Button onClick={openCreate}>
            <Plus className="mr-1 h-4 w-4" aria-hidden />
            New note
          </Button>
        }
      />

      {notes === null ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      ) : notes.length === 0 ? (
        <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
          No notes yet. Create one to get started.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {notes.map((n) => (
            <Card key={n.itemId} className="flex flex-col">
              <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
                <CardTitle className="text-base">{n.title}</CardTitle>
                <button
                  onClick={() => togglePin(n)}
                  aria-label={n.pinned ? "Unpin note" : "Pin note"}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {n.pinned ? (
                    <Pin className="h-4 w-4 fill-current" aria-hidden />
                  ) : (
                    <PinOff className="h-4 w-4" aria-hidden />
                  )}
                </button>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-3">
                {n.body ? (
                  <p className="line-clamp-4 whitespace-pre-wrap text-sm text-muted-foreground">
                    {n.body}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-1">
                  {n.notebook ? <Badge variant="secondary">{n.notebook}</Badge> : null}
                  {n.tags.map((t) => (
                    <Badge key={t} variant="outline">
                      {t}
                    </Badge>
                  ))}
                </div>
                <div className="mt-auto flex items-center justify-between pt-2">
                  <span className="text-xs text-muted-foreground">
                    edited {fmtRelative(n.updatedAt)}
                  </span>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(n)}>
                      <Pencil className="h-4 w-4" aria-hidden />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => remove(n)}>
                      <Trash2 className="h-4 w-4 text-red-600" aria-hidden />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{form.itemId ? "Edit note" : "New note"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="note-title">Title</Label>
              <Input
                id="note-title"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="note-body">Body</Label>
              <Textarea
                id="note-body"
                rows={6}
                value={form.body}
                onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="note-notebook">Notebook</Label>
                <Input
                  id="note-notebook"
                  value={form.notebook}
                  onChange={(e) => setForm((f) => ({ ...f, notebook: e.target.value }))}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="note-tags">Tags (comma-separated)</Label>
                <Input
                  id="note-tags"
                  value={form.tags}
                  onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.pinned}
                onChange={(e) => setForm((f) => ({ ...f, pinned: e.target.checked }))}
              />
              Pin this note
            </label>
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
