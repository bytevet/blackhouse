import { Link } from "react-router";
import { ChevronLeft, Moon, Sun } from "lucide-react";
import { useAppTheme } from "@/components/theme-provider";

/**
 * The thin breadcrumb strip above the agent header: where you came from, where
 * you are, and the theme toggle every screen in the design carries.
 */
export interface AgentTopBarProps {
  /** Channel slug to return to, when we know it. */
  backChannel?: string | null;
  handle: string;
}

export function AgentTopBar({ backChannel, handle }: AgentTopBarProps) {
  const { theme, toggle } = useAppTheme();

  return (
    <header
      style={{
        flex: "none",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 18px",
        borderBottom: "1px solid var(--ny-border)",
        background: "var(--ny-surface-sunken)",
      }}
    >
      <Link
        to={backChannel ? `/channels/${backChannel}` : "/agents"}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          textDecoration: "none",
          color: "var(--ny-text-subtle)",
          fontSize: 12.5,
          fontFamily: "var(--ny-font-mono)",
        }}
      >
        <ChevronLeft size={15} strokeWidth={2} aria-hidden="true" />
        {backChannel ? `#${backChannel}` : "agents"}
      </Link>
      <span style={{ color: "var(--ny-text-subtle)" }}>/</span>
      <Link
        to="/agents"
        style={{
          fontFamily: "var(--ny-font-mono)",
          fontSize: 12.5,
          color: "var(--ny-text)",
          textDecoration: "none",
        }}
      >
        agents
      </Link>
      <span style={{ color: "var(--ny-text-subtle)" }}>/</span>
      <span
        style={{
          fontFamily: "var(--ny-font-mono)",
          fontSize: 12.5,
          fontWeight: 600,
          color: "var(--ny-text)",
        }}
      >
        @{handle}
      </span>

      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
        <button
          type="button"
          onClick={toggle}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          title="Toggle theme"
          style={{
            width: 30,
            height: 30,
            borderRadius: 7,
            display: "grid",
            placeItems: "center",
            cursor: "pointer",
            color: "var(--ny-text-subtle)",
            border: "1px solid var(--ny-border)",
            background: "transparent",
          }}
        >
          {theme === "dark" ? (
            <Sun size={15} strokeWidth={2} aria-hidden="true" />
          ) : (
            <Moon size={15} strokeWidth={2} aria-hidden="true" />
          )}
        </button>
      </div>
    </header>
  );
}
