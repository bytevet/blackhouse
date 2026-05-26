import i18n from "i18next";
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

export default i18n;
