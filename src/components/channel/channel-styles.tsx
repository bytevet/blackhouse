/**
 * The handful of things inline styles genuinely cannot express: keyframes and
 * `:hover`. Everything else in this directory is `style={{…}}` over `--ny-*`
 * tokens, exactly as the design prototype does it.
 *
 * Rendered once by `ChannelPage`. It is scoped by the `bh-` prefix and lives
 * here rather than in `src/index.css` so the Channel View stays a
 * self-contained set of files.
 */
const CSS = `
@keyframes bhPulse { 0%,100% { opacity:1; transform:scale(1) } 50% { opacity:.4; transform:scale(.82) } }
@keyframes bhRing  { 0% { box-shadow:0 0 0 0 var(--bh-ring-color) } 70% { box-shadow:0 0 0 5px transparent } 100% { box-shadow:0 0 0 0 transparent } }

/* Scrollbars that read as part of the surface rather than the OS. */
.bh-scroll { scrollbar-width: thin; scrollbar-color: var(--ny-border-strong) transparent; }
.bh-scroll::-webkit-scrollbar { width: 10px; height: 10px }
.bh-scroll::-webkit-scrollbar-thumb { background: var(--ny-border-strong); border-radius: 8px; border: 2px solid transparent; background-clip: content-box }
.bh-scroll::-webkit-scrollbar-track { background: transparent }

/* Hover affordances. Split into two classes so a row can lift its background,
   its text, or both. */
.bh-hover { transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease }
.bh-hover:hover { background: var(--ny-surface-hover); color: var(--ny-text) }
.bh-hover-danger:hover { background: var(--ny-danger-subtle); color: var(--ny-danger-text) }
.bh-underline:hover { text-decoration: underline; text-underline-offset: 2px }

/* Focus rings come from the design system's token, not the UA default. */
.bh-focusable:focus-visible { outline: var(--ny-focus-ring-width) solid var(--ny-focus-ring); outline-offset: var(--ny-focus-ring-offset) }

/* Reset for the bare elements we style by hand. */
.bh-reset { appearance: none; border: none; background: none; padding: 0; margin: 0; font: inherit; color: inherit; text-align: inherit }
`;

export function ChannelStyles() {
  return <style>{CSS}</style>;
}
