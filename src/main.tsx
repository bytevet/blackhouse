import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { AppThemeProvider } from "@/components/theme-provider";
// Initialize i18next once, before any component that uses t() mounts.
import "./i18n";
// NotYet UI ships one stylesheet plus its font faces; both must load before
// any component renders, since every `--ny-*` token is defined there.
import "@notyet.im/ui/styles.css";
import "@notyet.im/ui/fonts.css";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AppThemeProvider>
        <App />
      </AppThemeProvider>
    </BrowserRouter>
  </StrictMode>,
);
