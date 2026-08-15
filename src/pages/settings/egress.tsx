import { useTranslation } from "react-i18next";
import { Alert, Badge, Spinner, Table, Text } from "@notyet.im/ui";
import { client, unwrap } from "@/lib/api";
import { useResource } from "@/hooks/use-resource";
import { SettingsHeader } from "@/layouts/settings-layout";

interface BlueprintRow {
  id: string;
  name: string;
  egressPolicy: string;
  egressAllowlist: string[] | null;
}

interface EgressRuleView {
  key: string;
  host: string;
  /** Which agents the rule reaches: a blueprint name, or the whole workspace. */
  scope: string;
  source: string;
}

/**
 * The effective allowlist, as far as the client can honestly see it today.
 *
 * The schema has an `egress_rules` table that is authoritative at connect
 * time, with `workspace` / `blueprint` / `agent` scopes and an "added by"
 * column — but no route serves it yet (that lands with the egress proxy in
 * Phase 6). What *does* exist is each blueprint's `egressAllowlist`, the
 * convenience default copied into those rules when an agent is created, so
 * that is what this page shows, labelled as such.
 *
 * Showing an editable workspace table backed by nothing would be worse than
 * showing less: an operator would add a host, see it listed, and believe an
 * agent could reach it.
 */
export function EgressPage() {
  const { t } = useTranslation();

  const blueprints = useResource<BlueprintRow[]>(
    async () => unwrap<BlueprintRow[]>(await client.api.settings.blueprints.$get()),
    [],
  );

  const rules: EgressRuleView[] = (blueprints.data ?? []).flatMap((bp) =>
    (bp.egressAllowlist ?? []).map((host) => ({
      key: `${bp.id}:${host}`,
      host,
      scope: bp.name,
      source: t("egress.sourceBlueprint"),
    })),
  );

  const enforcing = (blueprints.data ?? []).filter((bp) => bp.egressPolicy === "allowlist");
  const open = (blueprints.data ?? []).filter((bp) => bp.egressPolicy === "open");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <SettingsHeader title={t("egress.title")} description={t("egress.description")} />

      {blueprints.error && (
        <Alert tone="danger" title={t("egress.failed")}>
          {blueprints.error}
        </Alert>
      )}

      <Alert tone="info" title={t("egress.notEnforcedTitle")}>
        {t("egress.notEnforcedBody")}
      </Alert>

      {blueprints.loading && !blueprints.data ? (
        <div style={{ display: "grid", placeItems: "center", padding: 40 }} aria-busy="true">
          <Spinner label={t("common.loading")} />
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Badge tone="success" variant="subtle">
              {t("egress.countAllowlist", { count: enforcing.length })}
            </Badge>
            <Badge tone={open.length > 0 ? "warning" : "neutral"} variant="subtle">
              {t("egress.countOpen", { count: open.length })}
            </Badge>
          </div>

          <div style={{ overflowX: "auto" }} className="bh-scroll">
            <Table<EgressRuleView>
              caption={t("egress.tableCaption")}
              rowKey={(row) => row.key}
              rows={rules}
              empty={t("egress.empty")}
              density="compact"
              columns={[
                {
                  key: "host",
                  header: t("egress.host"),
                  render: (row) => (
                    <Text size="sm" mono>
                      {row.host}
                    </Text>
                  ),
                },
                {
                  key: "scope",
                  header: t("egress.scope"),
                  render: (row) => (
                    <Text size="xs" tone="subtle" mono>
                      {row.scope}
                    </Text>
                  ),
                },
                {
                  key: "source",
                  header: t("egress.source"),
                  render: (row) => (
                    <Text size="xs" tone="subtle">
                      {row.source}
                    </Text>
                  ),
                },
              ]}
            />
          </div>
        </>
      )}
    </div>
  );
}
