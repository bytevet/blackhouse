import "i18next";
import type en from "./locales/en.json";

/**
 * Type-augment i18next so `t("namespace.key")` calls are tsc-checked against
 * the English JSON. Missing/typo'd keys surface as type errors at the call
 * site — the strongest signal of extraction completeness.
 */
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof en };
  }
}
