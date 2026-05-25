import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import type { SessionStatus } from "@/db/schema";

interface IdeViewerProps {
  sessionId: string;
  status: SessionStatus;
}

export function IdeViewer({ sessionId, status }: IdeViewerProps) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState(false);

  if (status !== "running") {
    return (
      <div className="flex h-full items-center justify-center bg-muted text-xs text-muted-foreground">
        {t("ide.notRunning", { status })}
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted">
          <Skeleton className="size-8 bg-muted-foreground/20" />
        </div>
      )}
      <iframe
        src={`/api/sessions/${sessionId}/ide/`}
        title="Embedded IDE"
        className="h-full w-full border-0"
        allow="clipboard-read; clipboard-write"
        onLoad={() => setLoaded(true)}
      />
    </div>
  );
}
