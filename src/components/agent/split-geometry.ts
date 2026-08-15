/**
 * Pure geometry for the Agent Detail split divider.
 *
 * All of it lives here, away from the React component, for two reasons:
 * clamping bugs in a resizable pane are invisible until someone drags the
 * terminal to 3% and cannot get it back, and none of this needs a DOM to be
 * verified. `split-pane.tsx` is then a thin shell that translates pointer and
 * keyboard events into calls on these functions.
 *
 * Everything is expressed as a *percentage of the container's width occupied
 * by the left pane*, matching the prototype's `leftPct` state. Percentages
 * rather than pixels so a window resize keeps the ratio instead of stranding
 * one pane.
 */

export interface SplitBounds {
  /** Smallest allowed left-pane width, in percent. */
  minPct: number;
  /** Largest allowed left-pane width, in percent. */
  maxPct: number;
}

/**
 * Matches the prototype (`Math.max(26, Math.min(74, pct))`). The terminal is
 * the marquee pane, so neither side is ever allowed to become a sliver: below
 * ~26% an xterm grid is too narrow to read a stack trace, and above ~74% the
 * IDE next to it stops being usable.
 */
export const DEFAULT_BOUNDS: SplitBounds = { minPct: 26, maxPct: 74 };

/** Arrow-key increment. */
export const DEFAULT_STEP_PCT = 2;

/** Page-key increment — the "get me most of the way there" jump. */
export const DEFAULT_COARSE_STEP_PCT = 10;

/** The neutral position, used whenever an input is unusable. */
export const DEFAULT_LEFT_PCT = 50;

/**
 * Percentages are stored and persisted, so they are rounded to two decimals:
 * enough resolution that a drag feels continuous, few enough digits that a
 * value survives a JSON round-trip through localStorage unchanged.
 */
export function roundPct(pct: number): number {
  return Math.round(pct * 100) / 100;
}

/**
 * Coerce a caller-supplied (or localStorage-supplied) bounds pair into
 * something usable: inside 0–100, and with `min <= max`. Inverted bounds are
 * swapped rather than rejected — a split pane that throws is worse than one
 * that quietly does the sane thing.
 */
export function normaliseBounds(bounds?: Partial<SplitBounds>): SplitBounds {
  const rawMin = Number.isFinite(bounds?.minPct)
    ? (bounds!.minPct as number)
    : DEFAULT_BOUNDS.minPct;
  const rawMax = Number.isFinite(bounds?.maxPct)
    ? (bounds!.maxPct as number)
    : DEFAULT_BOUNDS.maxPct;
  const lo = Math.min(rawMin, rawMax);
  const hi = Math.max(rawMin, rawMax);
  return {
    minPct: Math.max(0, Math.min(100, lo)),
    maxPct: Math.max(0, Math.min(100, hi)),
  };
}

/** The midpoint of the allowed range — where an unusable value lands. */
export function midpointPct(bounds?: Partial<SplitBounds>): number {
  const { minPct, maxPct } = normaliseBounds(bounds);
  return roundPct((minPct + maxPct) / 2);
}

/**
 * Clamp a percentage into the allowed range.
 *
 * A non-finite input (`NaN` from a corrupt localStorage entry, `Infinity` from
 * a divide-by-zero container width) resolves to the midpoint rather than to a
 * bound: a restored layout that is merely *centred* reads as a fresh default,
 * whereas one pinned to its minimum reads as a bug.
 */
export function clampPct(pct: number, bounds?: Partial<SplitBounds>): number {
  const { minPct, maxPct } = normaliseBounds(bounds);
  if (!Number.isFinite(pct)) return roundPct((minPct + maxPct) / 2);
  return roundPct(Math.max(minPct, Math.min(maxPct, pct)));
}

/** The measurements a drag needs. Deliberately not a `DOMRect` so this is testable. */
export interface SplitRect {
  /** Container's left edge in client coordinates. */
  left: number;
  /** Container's width in CSS pixels. */
  width: number;
}

/**
 * Pointer position → clamped left-pane percentage.
 *
 * A zero or negative width means the container has not been laid out yet
 * (display:none, or a measurement taken before first paint); dividing by it
 * would yield `Infinity`, so we fall back to the midpoint instead.
 */
export function pctFromPointer(
  clientX: number,
  rect: SplitRect,
  bounds?: Partial<SplitBounds>,
): number {
  if (!Number.isFinite(clientX) || !Number.isFinite(rect?.width) || rect.width <= 0) {
    return midpointPct(bounds);
  }
  return clampPct(((clientX - rect.left) / rect.width) * 100, bounds);
}

export interface SplitKeyOptions {
  bounds?: Partial<SplitBounds>;
  /** Arrow-key increment. Default {@link DEFAULT_STEP_PCT}. */
  step?: number;
  /** Page-key increment. Default {@link DEFAULT_COARSE_STEP_PCT}. */
  coarseStep?: number;
}

/**
 * Keyboard handling for the divider, per the ARIA `separator` pattern.
 *
 * Returns the new percentage, or `null` when the key is not one this widget
 * owns — the caller uses that to decide whether to `preventDefault()`, so a
 * `Tab` out of the divider still works.
 *
 * Direction follows the visual axis rather than the value: `ArrowLeft` moves
 * the divider left, which *shrinks* the left pane.
 */
export function nextPctForKey(
  current: number,
  key: string,
  options?: SplitKeyOptions,
): number | null {
  const bounds = normaliseBounds(options?.bounds);
  const step = Number.isFinite(options?.step) ? (options!.step as number) : DEFAULT_STEP_PCT;
  const coarse = Number.isFinite(options?.coarseStep)
    ? (options!.coarseStep as number)
    : DEFAULT_COARSE_STEP_PCT;
  const from = clampPct(current, bounds);

  switch (key) {
    case "ArrowLeft":
      return clampPct(from - step, bounds);
    case "ArrowRight":
      return clampPct(from + step, bounds);
    case "PageUp":
      return clampPct(from - coarse, bounds);
    case "PageDown":
      return clampPct(from + coarse, bounds);
    case "Home":
      return clampPct(bounds.minPct, bounds);
    case "End":
      return clampPct(bounds.maxPct, bounds);
    default:
      return null;
  }
}

/** Whether {@link nextPctForKey} will act on this key. */
export function isSplitKey(key: string): boolean {
  return nextPctForKey(DEFAULT_LEFT_PCT, key) !== null;
}

/** `50` → `"50%"`. The value handed to `style.width`. */
export function pctStyleValue(pct: number, bounds?: Partial<SplitBounds>): string {
  return `${clampPct(pct, bounds)}%`;
}

/**
 * Parse a persisted value back into a usable percentage.
 *
 * localStorage is a public, editable, cross-version store: the value may be
 * absent, a string from an older schema, or outright garbage. Every one of
 * those resolves to `fallback` rather than propagating a `NaN` width into the
 * layout.
 */
export function parsePersistedPct(
  raw: string | null | undefined,
  bounds?: Partial<SplitBounds>,
  fallback: number = DEFAULT_LEFT_PCT,
): number {
  if (raw == null || raw === "") return clampPct(fallback, bounds);
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return clampPct(fallback, bounds);
  return clampPct(parsed, bounds);
}
