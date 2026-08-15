import { useTranslation } from "react-i18next";
import { Box, Server, ShieldAlert, ShieldCheck } from "lucide-react";
import { Alert, Badge, Spinner, Text } from "@notyet.im/ui";
import { SettingsHeader } from "@/layouts/settings-layout";
import { useRuntimes } from "@/hooks/use-runtimes";

/**
 * What this host can actually run.
 *
 * The page exists to be honest rather than reassuring. gVisor is absent on
 * macOS and on Podman, and Blackhouse falls back to `runc` silently at
 * container-create time — so an operator who never sees this screen can
 * believe they have a syscall boundary they do not have. Unavailable runtimes
 * therefore stay listed and greyed, never hidden, and the daemon's raw runtime
 * list is printed underneath so a mismatch in our own matcher is visible too.
 */
export function RuntimesPage() {
  const { t } = useTranslation();
  const { data, tiers, loading, error } = useRuntimes();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <SettingsHeader title={t("runtimes.title")} description={t("runtimes.description")} />

      {error && (
        <Alert tone="danger" title={t("runtimes.detectFailed")}>
          {error}
        </Alert>
      )}

      {loading && !data ? (
        <div style={{ display: "grid", placeItems: "center", padding: 40 }} aria-busy="true">
          <Spinner label={t("common.loading")} />
        </div>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              border: "1px solid var(--ny-border)",
              borderRadius: 10,
              background: "var(--ny-surface-sunken)",
              padding: "12px 15px",
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                width: 34,
                height: 34,
                borderRadius: 9,
                background: "var(--ny-surface)",
                border: "1px solid var(--ny-border)",
                display: "grid",
                placeItems: "center",
                color: "var(--ny-text-muted)",
              }}
            >
              <Server size={17} strokeWidth={1.8} />
            </span>
            <div style={{ flex: "1 1 200px", minWidth: 0 }}>
              <Text size="sm" weight="semibold">
                {t("runtimes.host")}
              </Text>
              <Text as="div" size="xs" tone="subtle" mono style={{ marginTop: 2 }}>
                {t("runtimes.defaultRuntime", { name: data?.defaultRuntime ?? "—" })}
              </Text>
            </div>
            <span
              style={{
                fontFamily: "var(--ny-font-mono)",
                fontSize: 11,
                color: data ? "var(--ny-success-text)" : "var(--ny-danger-text)",
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: data ? "var(--ny-success)" : "var(--ny-danger)",
                }}
              />
              {data ? t("runtimes.online") : t("runtimes.offline")}
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {tiers.map((rt) => (
              <div
                key={rt.id}
                style={{
                  display: "flex",
                  gap: 12,
                  alignItems: "flex-start",
                  border: "1px solid var(--ny-border)",
                  borderRadius: 10,
                  padding: "12px 14px",
                  background: "var(--ny-surface)",
                  opacity: rt.available ? 1 : 0.72,
                }}
              >
                <span
                  style={{
                    width: 30,
                    height: 30,
                    flex: "none",
                    borderRadius: 8,
                    display: "grid",
                    placeItems: "center",
                    background: rt.available
                      ? "var(--ny-success-subtle)"
                      : "var(--ny-surface-sunken)",
                    color: rt.available ? "var(--ny-success-text)" : "var(--ny-text-subtle)",
                  }}
                >
                  {rt.available ? (
                    rt.id === "runc" ? (
                      <Box size={16} />
                    ) : (
                      <ShieldCheck size={16} />
                    )
                  ) : (
                    <ShieldAlert size={16} />
                  )}
                </span>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span
                      style={{
                        fontFamily: "var(--ny-font-mono)",
                        fontSize: 13,
                        fontWeight: 600,
                        color: rt.available ? "var(--ny-text)" : "var(--ny-text-muted)",
                      }}
                    >
                      {rt.name}
                    </span>
                    <Badge tone={rt.available ? "success" : "neutral"} variant="outline" size="sm">
                      {t(rt.available ? "runtimes.available" : "runtimes.unavailable")}
                    </Badge>
                    {rt.detectedAs && rt.detectedAs !== rt.id && (
                      <Badge tone="info" variant="outline" size="sm">
                        {rt.detectedAs}
                      </Badge>
                    )}
                  </div>
                  <Text as="div" size="xs" tone="subtle" style={{ marginTop: 3 }}>
                    {t(rt.noteKey)}
                  </Text>
                </div>

                {rt.isDefault && (
                  <Badge tone="accent" variant="outline" size="sm">
                    {t("runtimes.default")}
                  </Badge>
                )}
              </div>
            ))}
          </div>

          {/* The daemon's own answer, unedited. If our matcher and this list
              disagree, the operator can see it rather than trusting us. */}
          <div>
            <Text as="div" size="xs" tone="subtle" style={{ marginBottom: 6 }}>
              {t("runtimes.rawHeading")}
            </Text>
            <div
              style={{
                fontFamily: "var(--ny-font-mono)",
                fontSize: 11.5,
                color: "var(--ny-text-muted)",
                border: "1px solid var(--ny-border)",
                borderRadius: 8,
                background: "var(--ny-surface-sunken)",
                padding: "8px 11px",
                overflowX: "auto",
              }}
            >
              {data && data.runtimes.length > 0 ? data.runtimes.join("  ·  ") : "—"}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
