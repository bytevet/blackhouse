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
syncHtmlLang(i18n.language);
i18n.on("languageChanged", syncHtmlLang);

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
