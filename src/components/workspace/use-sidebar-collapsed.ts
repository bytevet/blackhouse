import { useCallback, useState } from "react";

/**
 * Whether the rail is collapsed to its icon strip, remembered across reloads.
 *
 * Persisted for the same reason `leftPct` is in `use-split-layout.ts`: it is a
 * deliberate choice about how much of the screen you want given to navigation,
 * and having it snap back on every reload makes the control feel broken rather
 * than optional.
 *
 * Workspace-wide rather than per-route — the rail is one object that follows
 * you between channels and agents, so a per-room memory would make it flicker
 * open and shut as you moved.
 */

const KEY = "blackhouse.sidebar.collapsed";

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    // Private mode, or storage disabled. Expanded is the safer default: it is
    // the state where nothing is hidden behind a tooltip.
    return false;
  }
}

export function useSidebarCollapsed(): [
  boolean,
  (next: boolean | ((prev: boolean) => boolean)) => void,
] {
  const [collapsed, setCollapsed] = useState(read);

  const update = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    setCollapsed((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      try {
        window.localStorage.setItem(KEY, value ? "1" : "0");
      } catch {
        // Losing the preference is survivable; failing the click is not.
      }
      return value;
    });
  }, []);

  return [collapsed, update];
}
