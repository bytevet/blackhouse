import { describe, it, expect } from "vitest";
import {
  DEFAULT_BOUNDS,
  DEFAULT_COARSE_STEP_PCT,
  DEFAULT_LEFT_PCT,
  DEFAULT_STEP_PCT,
  clampPct,
  isSplitKey,
  midpointPct,
  nextPctForKey,
  normaliseBounds,
  parsePersistedPct,
  pctFromPointer,
  pctStyleValue,
  roundPct,
} from "@/components/agent/split-geometry";

/**
 * The divider's geometry, with no DOM in sight. Everything the resizable pane
 * can get wrong — a drag that escapes its bounds, a restored localStorage
 * value that poisons the layout with `NaN`, a keyboard step that walks past
 * the clamp — is decidable from these pure functions.
 */

describe("normaliseBounds", () => {
  it("defaults to the prototype's 26/74 range", () => {
    expect(normaliseBounds()).toEqual(DEFAULT_BOUNDS);
    expect(normaliseBounds({})).toEqual({ minPct: 26, maxPct: 74 });
  });

  it("fills in only the missing half", () => {
    expect(normaliseBounds({ minPct: 10 })).toEqual({ minPct: 10, maxPct: 74 });
    expect(normaliseBounds({ maxPct: 90 })).toEqual({ minPct: 26, maxPct: 90 });
  });

  it("swaps inverted bounds instead of throwing", () => {
    expect(normaliseBounds({ minPct: 80, maxPct: 20 })).toEqual({ minPct: 20, maxPct: 80 });
  });

  it("keeps bounds inside 0-100", () => {
    expect(normaliseBounds({ minPct: -30, maxPct: 400 })).toEqual({ minPct: 0, maxPct: 100 });
  });

  it("ignores non-finite bounds", () => {
    expect(normaliseBounds({ minPct: Number.NaN, maxPct: Number.POSITIVE_INFINITY })).toEqual(
      DEFAULT_BOUNDS,
    );
  });
});

describe("clampPct", () => {
  it("passes through a value already inside the range", () => {
    expect(clampPct(50)).toBe(50);
    expect(clampPct(26)).toBe(26);
    expect(clampPct(74)).toBe(74);
  });

  it("clamps to the minimum and maximum", () => {
    expect(clampPct(0)).toBe(26);
    expect(clampPct(-1000)).toBe(26);
    expect(clampPct(100)).toBe(74);
    expect(clampPct(1e9)).toBe(74);
  });

  it("honours custom bounds", () => {
    expect(clampPct(5, { minPct: 10, maxPct: 90 })).toBe(10);
    expect(clampPct(95, { minPct: 10, maxPct: 90 })).toBe(90);
    expect(clampPct(50, { minPct: 10, maxPct: 90 })).toBe(50);
  });

  it("resolves a non-finite value to the midpoint, not to a bound", () => {
    // A corrupt persisted value should read as "no preference", which is the
    // centre — landing on the minimum would look like a deliberate layout.
    expect(clampPct(Number.NaN)).toBe(50);
    expect(clampPct(Number.POSITIVE_INFINITY)).toBe(50);
    expect(clampPct(Number.NaN, { minPct: 20, maxPct: 60 })).toBe(40);
  });

  it("rounds to two decimals so persisted values round-trip", () => {
    expect(clampPct(33.333333)).toBe(33.33);
    expect(clampPct(66.666666)).toBe(66.67);
  });
});

describe("roundPct / midpointPct", () => {
  it("rounds to two decimals", () => {
    expect(roundPct(1 / 3)).toBe(0.33);
    expect(roundPct(50)).toBe(50);
  });

  it("reports the centre of the allowed range", () => {
    expect(midpointPct()).toBe(50);
    expect(midpointPct({ minPct: 30, maxPct: 70 })).toBe(50);
    expect(midpointPct({ minPct: 0, maxPct: 25 })).toBe(12.5);
  });
});

describe("pctFromPointer", () => {
  const rect = { left: 200, width: 1000 };

  it("converts a client x into a percentage of the container", () => {
    expect(pctFromPointer(700, rect)).toBe(50);
    expect(pctFromPointer(500, rect)).toBe(30);
    expect(pctFromPointer(900, rect)).toBe(70);
  });

  it("accounts for the container's own offset", () => {
    // The same client x means different things in different containers.
    expect(pctFromPointer(700, { left: 0, width: 1000 })).toBe(70);
    expect(pctFromPointer(700, { left: 200, width: 1000 })).toBe(50);
  });

  it("clamps a drag that runs past either edge", () => {
    expect(pctFromPointer(-5000, rect)).toBe(26);
    expect(pctFromPointer(5000, rect)).toBe(74);
    // Exactly on the container edges is still outside the bounds.
    expect(pctFromPointer(200, rect)).toBe(26);
    expect(pctFromPointer(1200, rect)).toBe(74);
  });

  it("respects custom bounds during a drag", () => {
    expect(pctFromPointer(210, rect, { minPct: 5, maxPct: 95 })).toBe(5);
    expect(pctFromPointer(1190, rect, { minPct: 5, maxPct: 95 })).toBe(95);
  });

  it("falls back to the midpoint for an unlaid-out container", () => {
    // Measured before first paint: dividing by zero would give Infinity.
    expect(pctFromPointer(700, { left: 0, width: 0 })).toBe(50);
    expect(pctFromPointer(700, { left: 0, width: -10 })).toBe(50);
    expect(pctFromPointer(Number.NaN, rect)).toBe(50);
  });
});

describe("nextPctForKey", () => {
  it("moves the divider along the visual axis", () => {
    // ArrowLeft moves the divider left, which shrinks the left pane.
    expect(nextPctForKey(50, "ArrowLeft")).toBe(50 - DEFAULT_STEP_PCT);
    expect(nextPctForKey(50, "ArrowRight")).toBe(50 + DEFAULT_STEP_PCT);
  });

  it("uses the coarse step for the page keys", () => {
    expect(nextPctForKey(50, "PageUp")).toBe(50 - DEFAULT_COARSE_STEP_PCT);
    expect(nextPctForKey(50, "PageDown")).toBe(50 + DEFAULT_COARSE_STEP_PCT);
  });

  it("jumps to the bounds with Home and End", () => {
    expect(nextPctForKey(50, "Home")).toBe(DEFAULT_BOUNDS.minPct);
    expect(nextPctForKey(50, "End")).toBe(DEFAULT_BOUNDS.maxPct);
  });

  it("clamps rather than walking past a bound", () => {
    expect(nextPctForKey(27, "ArrowLeft")).toBe(26);
    expect(nextPctForKey(26, "ArrowLeft")).toBe(26);
    expect(nextPctForKey(73, "ArrowRight")).toBe(74);
    expect(nextPctForKey(74, "ArrowRight")).toBe(74);
    expect(nextPctForKey(30, "PageUp")).toBe(26);
    expect(nextPctForKey(70, "PageDown")).toBe(74);
  });

  it("honours a custom step and custom bounds", () => {
    expect(nextPctForKey(50, "ArrowRight", { step: 0.5 })).toBe(50.5);
    expect(nextPctForKey(50, "PageDown", { coarseStep: 25 })).toBe(74);
    expect(
      nextPctForKey(50, "PageDown", { coarseStep: 25, bounds: { minPct: 5, maxPct: 95 } }),
    ).toBe(75);
    expect(nextPctForKey(50, "Home", { bounds: { minPct: 12, maxPct: 88 } })).toBe(12);
  });

  it("normalises an out-of-range starting value before stepping", () => {
    // A stale persisted value must not let one keypress escape the clamp.
    expect(nextPctForKey(500, "ArrowRight")).toBe(74);
    expect(nextPctForKey(-500, "ArrowLeft")).toBe(26);
    expect(nextPctForKey(Number.NaN, "ArrowRight")).toBe(50 + DEFAULT_STEP_PCT);
  });

  it("returns null for keys the divider does not own", () => {
    // The caller keys preventDefault() off this, so Tab must stay untouched.
    expect(nextPctForKey(50, "Tab")).toBeNull();
    expect(nextPctForKey(50, "ArrowUp")).toBeNull();
    expect(nextPctForKey(50, "Enter")).toBeNull();
    expect(nextPctForKey(50, "a")).toBeNull();
  });

  it("agrees with isSplitKey", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"]) {
      expect(isSplitKey(key)).toBe(true);
    }
    for (const key of ["Tab", "Escape", "ArrowUp", "ArrowDown", " "]) {
      expect(isSplitKey(key)).toBe(false);
    }
  });
});

describe("pctStyleValue", () => {
  it("renders a clamped CSS width", () => {
    expect(pctStyleValue(50)).toBe("50%");
    expect(pctStyleValue(0)).toBe("26%");
    expect(pctStyleValue(33.333)).toBe("33.33%");
  });
});

describe("parsePersistedPct", () => {
  it("reads a stored percentage back", () => {
    expect(parsePersistedPct("62.5")).toBe(62.5);
    expect(parsePersistedPct("26")).toBe(26);
  });

  it("falls back when the entry is missing", () => {
    expect(parsePersistedPct(null)).toBe(DEFAULT_LEFT_PCT);
    expect(parsePersistedPct(undefined)).toBe(DEFAULT_LEFT_PCT);
    expect(parsePersistedPct("")).toBe(DEFAULT_LEFT_PCT);
  });

  it("falls back when the entry is garbage", () => {
    // localStorage is user-editable and survives schema changes.
    expect(parsePersistedPct("not-a-number")).toBe(DEFAULT_LEFT_PCT);
    expect(parsePersistedPct("{}")).toBe(DEFAULT_LEFT_PCT);
    expect(parsePersistedPct("NaN")).toBe(DEFAULT_LEFT_PCT);
  });

  it("clamps a stored value written under different bounds", () => {
    expect(parsePersistedPct("5")).toBe(26);
    expect(parsePersistedPct("99")).toBe(74);
    expect(parsePersistedPct("5", { minPct: 2, maxPct: 98 })).toBe(5);
  });

  it("accepts a caller-supplied fallback, itself clamped", () => {
    expect(parsePersistedPct(null, undefined, 60)).toBe(60);
    expect(parsePersistedPct(null, undefined, 5)).toBe(26);
  });
});
