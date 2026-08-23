import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  DEFAULT_BOUNDS,
  DEFAULT_COARSE_STEP_PCT,
  DEFAULT_LEFT_PCT,
  DEFAULT_STEP_PCT,
  clampPct,
  nextPctForKey,
  normaliseBounds,
  pctFromPointer,
  pctStyleValue,
  type SplitBounds,
} from "./split-geometry";

/**
 * A two-pane horizontal split with a draggable, keyboard-operable divider.
 *
 * NotYet UI ships no resizable pane, so this is a project component. All the
 * arithmetic lives in `split-geometry.ts` and is unit-tested without a DOM;
 * what remains here is event plumbing and the ARIA contract.
 *
 * Notes on the interaction, in the order they bite:
 *
 * - **Pointer events, not mouse events.** One code path covers mouse, pen and
 *   touch, and `setPointerCapture` keeps the drag alive when the cursor
 *   outruns the 7px divider — which it always does — without listeners on
 *   `window` that have to be torn down by hand.
 * - **The rect is re-read on every move** rather than captured at
 *   pointer-down. A drag that lasts long enough for a window resize or a
 *   scroll is rare, but a stale rect silently maps the pointer to the wrong
 *   percentage, and `getBoundingClientRect` on one element per move is cheap.
 * - **The panes get `pointer-events: none` while dragging.** Both panes host
 *   iframes (code-server, the browser view); an iframe swallows pointer events
 *   the moment the cursor crosses into it, which would strand the divider
 *   mid-drag even with capture.
 * - **`role="separator"` with `tabIndex={0}`** is what makes this operable at
 *   all without a mouse; the value is mirrored into `aria-valuenow` so a
 *   screen reader announces the ratio as it changes.
 */
export interface SplitPaneProps {
  /** Left pane content. On Agent Detail this is always the terminal. */
  left: ReactNode;
  /** Right pane content — the secondary view. */
  right: ReactNode;
  /** Left pane width as a percentage of the container. Controlled. */
  leftPct: number;
  /** Called with the clamped percentage on every drag step and keypress. */
  onLeftPctChange: (pct: number) => void;
  /** Clamp, in percent. Defaults to {@link DEFAULT_BOUNDS} (26–74). */
  bounds?: Partial<SplitBounds>;
  /** Arrow-key increment. Default 2. */
  step?: number;
  /** Page-key increment. Default 10. */
  coarseStep?: number;
  /** Accessible name for the divider. */
  label?: string;
  /** Where a double-click on the divider resets to. Default 50. */
  resetPct?: number;
}

const DIVIDER_WIDTH = 7;

export function SplitPane({
  left,
  right,
  leftPct,
  onLeftPctChange,
  bounds,
  step = DEFAULT_STEP_PCT,
  coarseStep = DEFAULT_COARSE_STEP_PCT,
  label = "Resize panes",
  resetPct = DEFAULT_LEFT_PCT,
}: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  const resolved = normaliseBounds(bounds);
  const pct = clampPct(leftPct, resolved);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // Ignore secondary buttons: a right-click on the divider should open the
    // context menu, not start a drag that never receives its pointerup.
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }, []);

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      onLeftPctChange(pctFromPointer(event.clientX, rect, resolved));
    },
    [dragging, onLeftPctChange, resolved],
  );

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const next = nextPctForKey(pct, event.key, { bounds: resolved, step, coarseStep });
      // `null` means the divider does not own this key — leave Tab, Escape and
      // everything else to the browser.
      if (next === null) return;
      event.preventDefault();
      onLeftPctChange(next);
    },
    [pct, resolved, step, coarseStep, onLeftPctChange],
  );

  const paneStyle: CSSProperties = {
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    // Iframes inside a pane would otherwise capture the pointer mid-drag.
    pointerEvents: dragging ? "none" : undefined,
  };

  const active = dragging || hovered || focused;

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: "flex",
        flexDirection: "row",
        // Without this, dragging across text selects it and the cursor flickers
        // between col-resize and the I-beam.
        userSelect: dragging ? "none" : undefined,
      }}
    >
      <div style={{ ...paneStyle, flex: "none", width: pctStyleValue(pct, resolved) }}>{left}</div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuenow={Math.round(pct)}
        aria-valuemin={Math.round(resolved.minPct)}
        aria-valuemax={Math.round(resolved.maxPct)}
        aria-valuetext={`Terminal ${Math.round(pct)} percent`}
        tabIndex={0}
        title="Drag, or use the arrow keys, to resize · double-click to reset"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => onLeftPctChange(clampPct(resetPct, resolved))}
        onKeyDown={handleKeyDown}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          flex: "none",
          width: DIVIDER_WIDTH,
          cursor: "col-resize",
          background: active ? "var(--ny-accent)" : "var(--ny-border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          touchAction: "none",
          transition: "background .12s",
          outline: focused ? "2px solid var(--ny-accent)" : "none",
          outlineOffset: focused ? "-1px" : undefined,
        }}
      >
        {/* The grip. Two pixels wide so the divider reads as a handle rather
            than as a border that happens to be draggable. */}
        <span
          aria-hidden="true"
          style={{
            width: 2,
            height: 26,
            borderRadius: 2,
            background: active ? "var(--ny-text-on-accent)" : "var(--ny-text-subtle)",
          }}
        />
      </div>

      <div style={{ ...paneStyle, flex: 1 }}>{right}</div>
    </div>
  );
}
