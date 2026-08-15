import { useEffect, useRef, useState } from "react";
import { DEFAULT_LEFT_PCT, clampPct, parsePersistedPct } from "./split-geometry";

/**
 * Split-view state that survives a reload — per agent, not per app.
 *
 * Per agent because the right ratio is a property of the work: a terminal-heavy
 * agent wants 70/30, one you mostly watch in the IDE wants the reverse, and
 * carrying one global number between them means every navigation starts by
 * re-dragging the divider.
 */

const STORAGE_PREFIX = "blackhouse.agent-split";

function storageKey(agentId: string): string {
  return `${STORAGE_PREFIX}.${agentId}.leftPct`;
}

function readPct(agentId: string | undefined): number {
  if (!agentId || typeof window === "undefined") return DEFAULT_LEFT_PCT;
  try {
    return parsePersistedPct(window.localStorage.getItem(storageKey(agentId)));
  } catch {
    // Private mode, disabled storage, or a quota error. A layout preference is
    // never worth breaking the page over.
    return DEFAULT_LEFT_PCT;
  }
}

export function usePersistedLeftPct(agentId: string | undefined): [number, (pct: number) => void] {
  const [leftPct, setLeftPct] = useState(() => readPct(agentId));

  // Navigating from one agent to another re-reads that agent's stored ratio.
  // Done during render (the documented "adjust state when a prop changes"
  // pattern) so the first paint is never the previous agent's layout.
  const [seenAgentId, setSeenAgentId] = useState(agentId);
  if (seenAgentId !== agentId) {
    setSeenAgentId(agentId);
    setLeftPct(readPct(agentId));
  }

  // A drag fires this on every pointer move; writing to localStorage on each
  // one would put a synchronous disk-backed call in the middle of the frame.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!agentId || typeof window === "undefined") return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      try {
        window.localStorage.setItem(storageKey(agentId), String(clampPct(leftPct)));
      } catch {
        /* see readPct */
      }
    }, 200);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [agentId, leftPct]);

  return [leftPct, setLeftPct];
}

/**
 * Whether the viewport can carry two panes at once.
 *
 * Below this, split is not offered and any stored preference is ignored: two
 * 45%-wide panes on a phone are two unusable panes, and the terminal in
 * particular needs a readable column count. The page degrades to the single-
 * pane tab strip, which works at any width.
 */
export function useSplitAvailable(minWidth = 900): boolean {
  const query = `(min-width: ${minWidth}px)`;
  const [available, setAvailable] = useState(() =>
    typeof window === "undefined" ? true : window.matchMedia(query).matches,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setAvailable(event.matches);
    setAvailable(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return available;
}
