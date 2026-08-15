import type { ReactNode } from "react";
import { Link, NavLink, Outlet } from "react-router";
import { useTranslation } from "react-i18next";
import { Box, ChevronLeft, LayoutGrid, ShieldCheck, UserRound, Users } from "lucide-react";
import { Heading, Text, ThemeToggle } from "@notyet.im/ui";
import { useAppTheme } from "@/components/theme-provider";
import { LanguageSwitcher } from "@/components/language-switcher";

interface NavEntry {
  to: string;
  labelKey: string;
  icon: ReactNode;
}

const NAV: NavEntry[] = [
  {
    to: "/settings/blueprints",
    labelKey: "settings.nav.blueprints",
    icon: <LayoutGrid size={16} />,
  },
  { to: "/settings/runtimes", labelKey: "settings.nav.runtimes", icon: <Box size={16} /> },
  { to: "/settings/egress", labelKey: "settings.nav.egress", icon: <ShieldCheck size={16} /> },
  { to: "/settings/members", labelKey: "settings.nav.members", icon: <Users size={16} /> },
  { to: "/settings/profile", labelKey: "settings.nav.profile", icon: <UserRound size={16} /> },
];

/**
 * Workspace settings shell: a top bar back to the channels, a section rail,
 * and the outlet.
 *
 * The rail is a `<nav>` of `NavLink`s rather than `Tabs`: these are real routes
 * with their own URLs, and a tablist would misdescribe them to assistive tech
 * as views of one page.
 */
export function SettingsLayout() {
  const { t } = useTranslation();
  const { theme, setTheme } = useAppTheme();

  return (
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--ny-bg)",
        color: "var(--ny-text)",
        fontFamily: "var(--ny-font-sans)",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "11px 20px",
          borderBottom: "1px solid var(--ny-border)",
          background: "var(--ny-surface-sunken)",
        }}
      >
        <Link
          to="/channels"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            textDecoration: "none",
            color: "var(--ny-text-subtle)",
            fontFamily: "var(--ny-font-mono)",
            fontSize: 12.5,
          }}
        >
          <ChevronLeft size={15} />
          {t("settings.backToWorkspace")}
        </Link>
        <span style={{ color: "var(--ny-text-subtle)" }}>/</span>
        <span style={{ fontFamily: "var(--ny-font-mono)", fontSize: 12.5, fontWeight: 600 }}>
          {t("settings.title")}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          <LanguageSwitcher />
          <ThemeToggle theme={theme} onChange={setTheme} label={t("nav.toggleTheme")} />
        </div>
      </header>

      <div className="bh-settings-body">
        <nav className="bh-settings-nav bh-scroll" aria-label={t("settings.title")}>
          <div
            className="bh-settings-nav-eyebrow"
            style={{
              padding: "4px 10px 8px",
              fontSize: 10.5,
              fontFamily: "var(--ny-font-mono)",
              textTransform: "uppercase",
              letterSpacing: ".06em",
              color: "var(--ny-text-subtle)",
            }}
          >
            {t("settings.workspace")}
          </div>
          {NAV.map((entry) => (
            <NavLink
              key={entry.to}
              to={entry.to}
              style={({ isActive }) => ({
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                borderRadius: 8,
                textDecoration: "none",
                fontSize: 13,
                whiteSpace: "nowrap",
                background: isActive ? "var(--ny-surface-selected)" : "transparent",
                color: isActive ? "var(--ny-text)" : "var(--ny-text-muted)",
                fontWeight: isActive ? 600 : 400,
              })}
            >
              {entry.icon}
              <span>{t(entry.labelKey)}</span>
            </NavLink>
          ))}
        </nav>

        <main
          className="bh-scroll"
          style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: "26px 24px 60px" }}
        >
          <div style={{ maxWidth: 900 }}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

/**
 * Title + blurb + optional action, shared by every settings section so the
 * four screens keep one rhythm. Exported from the layout rather than from a
 * components file because it is meaningless outside it.
 */
export function SettingsHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 320px", minWidth: 0 }}>
        <Heading as="h1" size="2xl">
          {title}
        </Heading>
        <Text
          as="p"
          size="sm"
          tone="muted"
          style={{ marginTop: 4, maxWidth: 560, lineHeight: 1.5 }}
        >
          {description}
        </Text>
      </div>
      {action}
    </div>
  );
}
