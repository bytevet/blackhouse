import type { CSSProperties } from "react";

/**
 * The brand mark — a rounded accent square holding a monospace "B", exactly as
 * the login mockup draws it.
 *
 * Painted with `--ny-accent` / `--ny-text-on-accent` rather than
 * `currentColor`, because the mark is a fixed brand object: it should not
 * recolour to whatever text tone it happens to sit next to.
 */
export function LogoMark({ size = 38, style }: { size?: number; style?: CSSProperties }) {
  return (
    <div
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        flex: "none",
        borderRadius: Math.round(size * 0.26),
        background: "var(--ny-accent)",
        color: "var(--ny-text-on-accent)",
        display: "grid",
        placeItems: "center",
        fontFamily: "var(--ny-font-mono)",
        fontWeight: 700,
        fontSize: Math.round(size * 0.45),
        ...style,
      }}
    >
      B
    </div>
  );
}

/**
 * Mark + wordmark + host line. The subtitle is the deployment's own hostname:
 * Blackhouse is self-hosted, and which box you are signed in to is the one
 * piece of context the brand block can usefully carry.
 */
export function Logo({ size = 38 }: { size?: number }) {
  const host = typeof window === "undefined" ? "" : window.location.host;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
      <LogoMark size={size} />
      <div>
        <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-.01em" }}>Blackhouse</div>
        <div
          style={{
            fontFamily: "var(--ny-font-mono)",
            fontSize: 11,
            color: "var(--ny-text-subtle)",
            marginTop: 1,
          }}
        >
          self-hosted{host ? ` · ${host}` : ""}
        </div>
      </div>
    </div>
  );
}
