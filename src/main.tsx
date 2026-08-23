import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { AppThemeProvider } from "@/components/theme-provider";
// Initialize i18next once, before any component that uses t() mounts.
import "./i18n";
// NotYet UI's stylesheet must load before any component renders, since every
// `--ny-*` token is defined there. Its companion `fonts.css` is deliberately
// not imported: it fetches IBM Plex and three Noto CJK families from Google on
// every load. `index.css` self-hosts the Latin faces and follows this import,
// so its `--ny-font-sans` override lands after the token it replaces.
import "@notyet.im/ui/styles.css";
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
