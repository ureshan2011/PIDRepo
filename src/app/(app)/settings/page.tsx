"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface AiSettings {
  "ai.baseUrl": string;
  "ai.chatModel": string;
  "ai.classifierModel": string;
  "ai.embeddingModel": string;
  "ai.apiKey": string;
  "ai.requestTimeoutMs": number;
  "ai.contextWindowOverride": number;
}

const FIELDS: { key: keyof AiSettings; label: string; type: "text" | "number" }[] = [
  { key: "ai.baseUrl", label: "LM Studio Base URL", type: "text" },
  { key: "ai.chatModel", label: "Chat Model", type: "text" },
  { key: "ai.classifierModel", label: "Classifier Model", type: "text" },
  { key: "ai.embeddingModel", label: "Embedding Model", type: "text" },
  { key: "ai.apiKey", label: "API Key (placeholder)", type: "text" },
  { key: "ai.requestTimeoutMs", label: "Request Timeout (ms)", type: "number" },
  { key: "ai.contextWindowOverride", label: "Context Window Override", type: "number" },
];

export default function SettingsPage() {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: AiSettings) => setSettings(data))
      .catch(() => toast.error("Failed to load settings"));
  }, []);

  const update = (key: keyof AiSettings, raw: string, type: "text" | "number") => {
    setSettings((prev) =>
      prev ? { ...prev, [key]: type === "number" ? Number(raw) : raw } : prev,
    );
  };

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (!res.ok) throw new Error(await res.text());
      const updated = (await res.json()) as AiSettings;
      setSettings(updated);
      toast.success("Settings saved");
    } catch {
      toast.error("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl">
      <PageHeader title="Settings" description="AI runtime configuration (LM Studio)." />
      <Card>
        <CardHeader>
          <CardTitle>AI Runtime</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!settings ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <>
              {FIELDS.map((f) => (
                <div key={f.key} className="grid gap-2">
                  <Label htmlFor={f.key}>{f.label}</Label>
                  <Input
                    id={f.key}
                    type={f.type}
                    value={String(settings[f.key] ?? "")}
                    onChange={(e) => update(f.key, e.target.value, f.type)}
                  />
                </div>
              ))}
              <Button onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
