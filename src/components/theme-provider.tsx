import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ThemeProvider } from "@notyet.im/ui";

const STORAGE_KEY = "blackhouse-theme";

export type Theme = "light" | "dark";

function initialTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  // Blackhouse is a terminal-adjacent tool; dark is the sane default when the
  // OS expresses no preference.
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

interface ThemeContextValue {
  theme: Theme;
  toggle: () => void;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Wraps NotYet UI's `ThemeProvider`, which owns the `--ny-*` token values, and
 * adds the persistence the library deliberately leaves to the consumer.
 *
 * Every screen in the design carries a theme toggle, so this is app-wide state
 * held in one place — consumers read it through `useAppTheme`.
 */
export function AppThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(initialTheme);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, theme);
    // Mirror onto the document so non-NotYet surfaces (xterm.js, and the IDE
    // and browser iframes) can react to the same signal.
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const setTheme = useCallback((next: Theme) => setThemeState(next), []);
  const toggle = useCallback(
    () => setThemeState((current) => (current === "dark" ? "light" : "dark")),
    [],
  );

  return (
    <ThemeContext.Provider value={{ theme, toggle, setTheme }}>
      <ThemeProvider theme={theme}>{children}</ThemeProvider>
    </ThemeContext.Provider>
  );
}

/** Read + toggle the app theme. Must be called inside `AppThemeProvider`. */
export function useAppTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useAppTheme must be used within AppThemeProvider");
  return ctx;
}
