"use client";

import { RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fmtRelative } from "./format";
import { HealthBadge, type HealthStatusDb } from "./HealthBadge";

export interface ConnectionAccount {
  sourceId: string;
  displayName: string;
  category: string;
  tap: string | null;
  status: HealthStatusDb;
  statusReason?: string | null;
  lastSyncAt?: number | null;
}

/**
 * Settings → Connections health surface (BUILD_SPEC §9). Renders the five-value
 * status enum with color+icon badges, last sync time, Sync-now + Reconnect
 * actions. Loading → skeleton rows; empty → add-account CTA.
 */
export function ConnectionHealthList({
  accounts,
  loading,
  syncingId,
  onSyncNow,
  onReconnect,
}: {
  accounts: ConnectionAccount[];
  loading?: boolean;
  syncingId?: string | null;
  onSyncNow: (sourceId: string) => void;
  onReconnect: (sourceId: string) => void;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-8 text-center">
        <p className="text-sm font-medium">No connected accounts yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Add your first account to start syncing data into PID.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Account</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Tap</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last sync</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {accounts.map((a) => (
            <TableRow key={`${a.sourceId}-${a.tap ?? "none"}`}>
              <TableCell className="font-medium">{a.displayName}</TableCell>
              <TableCell className="text-muted-foreground">{a.category}</TableCell>
              <TableCell className="text-muted-foreground">{a.tap ?? "—"}</TableCell>
              <TableCell>
                <HealthBadge status={a.status} />
                {a.statusReason ? (
                  <div className="mt-1 text-xs text-muted-foreground">{a.statusReason}</div>
                ) : null}
              </TableCell>
              <TableCell className="tabular-nums text-muted-foreground">
                {fmtRelative(a.lastSyncAt)}
              </TableCell>
              <TableCell>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onSyncNow(a.sourceId)}
                    disabled={syncingId === a.sourceId}
                  >
                    <RefreshCw
                      className={
                        syncingId === a.sourceId ? "mr-1 h-3.5 w-3.5 animate-spin" : "mr-1 h-3.5 w-3.5"
                      }
                      aria-hidden
                    />
                    Sync now
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => onReconnect(a.sourceId)}>
                    <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden />
                    Reconnect
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
