import { useEffect, useState } from "react";

/**
 * Subscribe to a media query.
 *
 * The Channel View needs a real breakpoint rather than a CSS-only one because
 * the narrow layout changes *behaviour*, not just size: the sidebar becomes a
 * modal drawer with its own dismiss, which is a different component tree.
 */
export function useMediaQuery(query: string): boolean {
  // `matchMedia?.` rather than `matchMedia`: jsdom and other non-browser hosts
  // do not implement it, and a layout hook must not be the thing that stops a
  // page rendering at all.
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches ?? false);

  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(list.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
