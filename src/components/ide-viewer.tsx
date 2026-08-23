import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Skeleton, Text } from "@notyet.im/ui";
import type { AgentStatus } from "@/db/schema";

interface IdeViewerProps {
  agentId: string;
  status: AgentStatus;
}

export function IdeViewer({ agentId, status }: IdeViewerProps) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState(false);

  if (status !== "running") {
    return (
      <div
        style={{
          height: "100%",
          display: "grid",
          placeItems: "center",
          background: "var(--ny-surface-sunken)",
        }}
      >
        <Text size="xs" tone="subtle">
          {t("ide.notRunning", { status })}
        </Text>
      </div>
    );
  }

  return (
    <div style={{ position: "relative", height: "100%", width: "100%" }}>
      {!loaded && (
        <div
          aria-busy="true"
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            background: "var(--ny-surface-sunken)",
          }}
        >
          <Skeleton shape="rect" width="70%" height="60%" />
        </div>
      )}
      <iframe
        src={`/api/agents/${agentId}/ide/`}
        title="Embedded IDE"
        style={{ height: "100%", width: "100%", border: 0, display: "block" }}
        allow="clipboard-read; clipboard-write"
        onLoad={() => setLoaded(true)}
      />
    </div>
  );
}
