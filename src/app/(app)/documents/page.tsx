"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shell/PageHeader";
import { Badge } from "@/components/ui/badge";
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
import { fmtRelative } from "@/components/pid/format";
import { cn } from "@/lib/utils";

type ParseStatus = "pending" | "parsed" | "failed";

interface DocumentDTO {
  itemId: string;
  title: string;
  mimeType: string | null;
  fileSizeBytes: number | null;
  pageCount: number | null;
  status: ParseStatus;
  createdAt: number;
}

const ACCEPT = ".pdf,.docx,.pptx,.txt,.md";
const MAX_BYTES = 25 * 1024 * 1024;

function fmtSize(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtType(mime: string | null, title: string): string {
  const ext = title.includes(".") ? title.split(".").pop()?.toUpperCase() : null;
  if (ext) return ext;
  if (mime?.includes("pdf")) return "PDF";
  if (mime?.includes("word")) return "DOCX";
  if (mime?.includes("presentation")) return "PPTX";
  if (mime?.includes("markdown")) return "MD";
  if (mime?.includes("plain")) return "TXT";
  return "—";
}

function StatusBadge({ status }: { status: ParseStatus }) {
  if (status === "parsed") {
    return (
      <Badge variant="secondary" className="border-green-600/30 bg-green-600/10 text-green-700 dark:text-green-400">
        Parsed
      </Badge>
    );
  }
  if (status === "failed") {
    return <Badge variant="destructive">Failed</Badge>;
  }
  return <Badge variant="outline">Pending</Badge>;
}

export default function DocumentsPage() {
  const [docs, setDocs] = useState<DocumentDTO[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/documents", { cache: "no-store" });
      const data = (await res.json()) as { documents: DocumentDTO[] };
      setDocs(data.documents);
    } catch {
      toast.error("Failed to load documents");
      setDocs([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while any document is still parsing so Pending -> Parsed flips live.
  useEffect(() => {
    if (!docs || !docs.some((d) => d.status === "pending")) return;
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [docs, load]);

  const upload = useCallback(
    async (file: File) => {
      const lower = file.name.toLowerCase();
      if (!ACCEPT.split(",").some((ext) => lower.endsWith(ext))) {
        toast.error("Unsupported file type. Allowed: pdf, docx, pptx, txt, md");
        return;
      }
      if (file.size > MAX_BYTES) {
        toast.error("File exceeds the 25 MB limit");
        return;
      }
      setUploading(true);
      try {
        const body = new FormData();
        body.append("file", file);
        const res = await fetch("/api/documents", { method: "POST", body });
        if (!res.ok) throw new Error();
        toast.success(`Uploaded ${file.name}`);
        await load();
      } catch {
        toast.error(`Failed to upload ${file.name}`);
      } finally {
        setUploading(false);
      }
    },
    [load],
  );

  const onFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      for (const file of Array.from(files)) {
        await upload(file);
      }
    },
    [upload],
  );

  const remove = async (doc: DocumentDTO) => {
    try {
      const res = await fetch(`/api/documents/${doc.itemId}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast.success("Document deleted");
      void load();
    } catch {
      toast.error("Failed to delete document");
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Documents"
        description="Import files (PDF, DOCX, PPTX, txt, md). Text is extracted, chunked, and embedded automatically."
        actions={
          <Button onClick={() => inputRef.current?.click()} disabled={uploading}>
            <Upload className="mr-1 h-4 w-4" aria-hidden />
            {uploading ? "Uploading…" : "Upload"}
          </Button>
        }
      />

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => {
          void onFiles(e.target.files);
          e.target.value = "";
        }}
      />

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void onFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-10 text-center text-sm transition-colors",
          dragging
            ? "border-primary bg-primary/5 text-foreground"
            : "border-muted-foreground/25 text-muted-foreground hover:border-muted-foreground/50",
        )}
      >
        <Upload className="h-6 w-6" aria-hidden />
        <span>Drag &amp; drop files here, or click to browse</span>
        <span className="text-xs">PDF, DOCX, PPTX, txt, md · up to 25 MB</span>
      </div>

      {docs === null ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : docs.length === 0 ? (
        <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
          No documents yet. Upload one to get started.
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Pages</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Added</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {docs.map((d) => (
                <TableRow key={d.itemId}>
                  <TableCell className="font-medium">
                    <span className="flex items-center gap-2">
                      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="truncate">{d.title}</span>
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{fmtType(d.mimeType, d.title)}</TableCell>
                  <TableCell className="text-muted-foreground">{fmtSize(d.fileSizeBytes)}</TableCell>
                  <TableCell className="text-muted-foreground">{d.pageCount ?? "—"}</TableCell>
                  <TableCell>
                    <StatusBadge status={d.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{fmtRelative(d.createdAt)}</TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Delete ${d.title}`}
                      onClick={() => remove(d)}
                    >
                      <Trash2 className="h-4 w-4 text-red-600" aria-hidden />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
