import i18n, { type ParseKeys } from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

/**
 * Initialize i18next once at app boot. Detection chain: localStorage key
 * `blackhouse-lang` → browser navigator → fallback `en`. Choice persists
 * back to localStorage. zh-CN ships as a stub (values are literal English
 * copies); future translator work edits values without touching code.
 */
void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: "en",
    supportedLngs: ["en", "zh-CN"],
    resources: {
      en: { translation: en },
      "zh-CN": { translation: zhCN },
    },
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "blackhouse-lang",
      caches: ["localStorage"],
    },
    interpolation: { escapeValue: false }, // React already escapes
  });

// Keep <html lang> in sync so screen-readers + CSS lang selectors pick up
// the active locale. Fires on the initial language and any subsequent change.
function syncHtmlLang(lng: string) {
  if (typeof document !== "undefined") {
    document.documentElement.lang = lng;
  }
}

/**
 * Noto Sans SC, fetched from Google the first time a Chinese locale is chosen
 * and never otherwise.
 *
 * The Latin faces are self-hosted (`src/index.css`), but a CJK family is
 * megabytes across dozens of subset files and is not worth shipping with an
 * app whose default locale is English. So this one face stays remote — and
 * because it stays remote, it must not be on the boot path: an unconditional
 * `@import` would put a render-blocking request to fonts.googleapis.com in
 * front of every cold load, English sessions included, which is the exact cost
 * self-hosting was meant to remove.
 *
 * The trade is deliberate and narrow: a zh-CN session accepts one third-party
 * request for legible text; an English session — the default, and the whole
 * offline story — makes none. Sessions that never touch zh-CN never learn that
 * Google is in the stylesheet at all.
 *
 * Injected as a <link> rather than an `@import`, so it resolves in parallel
 * with the page instead of blocking the sheet that names it. Idempotent by id:
 * the locale can be toggled zh -> en -> zh without stacking duplicate sheets,
 * and once fetched the face is simply left in place, since tearing it out on
 * a switch back to English would only re-download it on the next switch.
 */
const CJK_FONT_LINK_ID = "bh-cjk-font";
const CJK_FONT_HREF =
  "https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;600&display=swap";

function ensureCjkFont(lng: string) {
  // Matches "zh", "zh-CN", "zh-Hans" alike. `supportedLngs` narrows the app to
  // zh-CN, but the detector reports whatever the browser said before i18next
  // resolves it, and every one of those spellings wants the same face.
  if (typeof document === "undefined" || !lng.toLowerCase().startsWith("zh")) return;
  if (document.getElementById(CJK_FONT_LINK_ID)) return;

  const link = document.createElement("link");
  link.id = CJK_FONT_LINK_ID;
  link.rel = "stylesheet";
  link.href = CJK_FONT_HREF;
  document.head.appendChild(link);
}

function onLanguage(lng: string) {
  syncHtmlLang(lng);
  ensureCjkFont(lng);
}

onLanguage(i18n.language);
i18n.on("languageChanged", onLanguage);

/**
 * The key union `t()` accepts, generated from `en.json` by the module
 * augmentation in `i18next.d.ts`.
 *
 * Needed only where a key is chosen at runtime — `agentStatusConfig` and
 * friends store `labelKey` as a plain `string`, because the mapping lives in
 * `lib/` and must not depend on the locale files. Those call sites assert
 * through this type rather than through `any`, so a typo still fails at
 * runtime in the obvious way but the rest of the call keeps its checking.
 *
 * Narrowed to the string members with `Extract`: `ParseKeys` also admits
 * `string[]` and `TemplateStringsArray` for i18next's fallback-key and
 * tagged-template forms, and a union containing those does not match the
 * single-key `t()` overload — so the unnarrowed type fails at every call site
 * it was introduced to fix.
 */
export type TranslationKey = Extract<ParseKeys, string>;

export default i18n;
