"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shell/PageHeader";
import {
  ConnectionHealthList,
  type ConnectionAccount,
} from "@/components/pid/ConnectionHealthList";

export default function ConnectionsPage() {
  const [accounts, setAccounts] = useState<ConnectionAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncingId, setSyncingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/connections", { cache: "no-store" });
      const data = (await res.json()) as { accounts: ConnectionAccount[] };
      setAccounts(data.accounts);
    } catch {
      toast.error("Failed to load connections");
      setAccounts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onSyncNow = async (sourceId: string) => {
    setSyncingId(sourceId);
    try {
      const res = await fetch(`/api/connections/${sourceId}/sync-now`, { method: "POST" });
      if (!res.ok) throw new Error();
      toast.success("Sync queued");
      // Refresh after a short delay so the worker has a chance to run.
      setTimeout(() => void load(), 1500);
    } catch {
      toast.error("Failed to queue sync");
    } finally {
      setSyncingId(null);
    }
  };

  const onReconnect = () => {
    // Phase 1 stub — the seed source needs no re-consent (BUILD_SPEC §9).
    toast.info("Reconnect flow is available for real connectors in a later phase.");
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Connections"
        description="Connector accounts and their sync health."
      />
      <ConnectionHealthList
        accounts={accounts}
        loading={loading}
        syncingId={syncingId}
        onSyncNow={onSyncNow}
        onReconnect={onReconnect}
      />
    </div>
  );
}
