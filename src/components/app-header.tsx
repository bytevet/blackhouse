import type { ReactNode } from "react";
import { Link } from "react-router";
import { ChevronLeft } from "lucide-react";
import { ThemeToggle } from "@notyet.im/ui";
import { useAppTheme } from "@/components/theme-provider";
import { LanguageSwitcher } from "@/components/language-switcher";
import { useTranslation } from "react-i18next";

/**
 * The strip at the very top of every full-page screen.
 *
 * It exists because there were three of these — on `/agents`, on `/settings/*`
 * and on `/agents/:id` — hand-rolled separately and drifted apart. Their
 * paddings were `11px 20px`, `11px 20px` and `10px 18px`, so the content below
 * them moved by a pixel or two as you navigated, and only two of the three
 * carried the language switcher. One of them re-implemented `ThemeToggle` as a
 * bare button, so the control changed shape between screens as well.
 *
 * Height comes from `--bh-header-h` rather than from padding, so every screen's
 * first row of content starts on the same line no matter what the bar contains
 * — a breadcrumb, a channel title, or a taller control.
 */

export interface Crumb {
  label: ReactNode;
  /** Omit on the last crumb — the page you are already on is not a link. */
  to?: string;
}

export interface AppHeaderProps {
  /**
   * Left-most "go back" affordance, rendered with a chevron. Separate from
   * `crumbs` because it is the escape hatch, not a position in the trail.
   */
  back?: { label: ReactNode; to: string };
  crumbs?: Crumb[];
  /** Extra controls, placed before the language and theme toggles. */
  actions?: ReactNode;
  /**
   * Drop the language/theme toggles — for a screen that already carries them
   * elsewhere. They are on by default so a screen cannot forget them.
   */
  hideGlobalActions?: boolean;
  children?: ReactNode;
}

const crumbText = {
  fontFamily: "var(--ny-font-mono)",
  fontSize: 12.5,
  textDecoration: "none",
} as const;

export function AppHeader({
  back,
  crumbs = [],
  actions,
  hideGlobalActions = false,
  children,
}: AppHeaderProps) {
  const { t } = useTranslation();
  const { theme, setTheme } = useAppTheme();

  return (
    <header className="bh-app-header">
      {back && (
        <Link
          to={back.to}
          style={{
            ...crumbText,
            display: "flex",
            alignItems: "center",
            gap: 7,
            color: "var(--ny-text-subtle)",
          }}
        >
          <ChevronLeft size={15} aria-hidden="true" />
          {back.label}
        </Link>
      )}

      {crumbs.map((crumb, i) => (
        <span key={i} style={{ display: "contents" }}>
          {(back || i > 0) && (
            <span aria-hidden="true" style={{ color: "var(--ny-text-subtle)" }}>
              /
            </span>
          )}
          {crumb.to ? (
            <Link to={crumb.to} style={{ ...crumbText, color: "var(--ny-text)" }}>
              {crumb.label}
            </Link>
          ) : (
            // The trailing crumb is the current page. Bolder, and not a link.
            <span style={{ ...crumbText, fontWeight: 600, color: "var(--ny-text)" }}>
              {crumb.label}
            </span>
          )}
        </span>
      ))}

      {children}

      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
        {actions}
        {!hideGlobalActions && (
          <>
            <LanguageSwitcher />
            <ThemeToggle theme={theme} onChange={setTheme} label={t("nav.toggleTheme")} />
          </>
        )}
      </div>
    </header>
  );
}
