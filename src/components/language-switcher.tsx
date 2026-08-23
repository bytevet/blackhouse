import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";
import { Popover } from "@notyet.im/ui";

interface LangOption {
  code: string;
  label: string;
}

const LANGUAGES: LangOption[] = [
  { code: "en", label: "English" },
  { code: "zh-CN", label: "中文" },
];

/**
 * Locale picker. Persists through the browser-language-detector's
 * localStorage cache, so a refresh keeps the selection.
 *
 * NotYet ships no dropdown-menu primitive, so this is a `Popover` holding a
 * plain button list. The distinction the library draws is deliberate — a menu
 * is interactive content, which is exactly what `Popover` is for, whereas
 * `Select` is a form control and would submit rather than act.
 *
 * The trigger is a bare `<button>`, not NotYet's `Button`: `Popover` clones
 * `aria-expanded` and `aria-controls` onto its child, and a component that
 * does not spread unknown props silently drops them. It is sized and coloured
 * to match `ThemeToggle`, which it always sits beside.
 */
export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      placement="top"
      content={
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 120 }}>
          {LANGUAGES.map((lang) => {
            const active = i18n.resolvedLanguage === lang.code;
            return (
              <button
                key={lang.code}
                type="button"
                onClick={() => {
                  void i18n.changeLanguage(lang.code);
                  setOpen(false);
                }}
                style={{
                  appearance: "none",
                  border: "none",
                  textAlign: "left",
                  cursor: "pointer",
                  borderRadius: 7,
                  padding: "6px 10px",
                  fontSize: 13,
                  fontFamily: "var(--ny-font-sans)",
                  background: active ? "var(--ny-surface-selected)" : "transparent",
                  color: active ? "var(--ny-text)" : "var(--ny-text-muted)",
                  fontWeight: active ? 600 : 400,
                }}
              >
                {lang.label}
              </button>
            );
          })}
        </div>
      }
    >
      <button
        type="button"
        aria-label={t("nav.language")}
        style={{
          width: "var(--ny-control-height-md)",
          height: "var(--ny-control-height-md)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          borderRadius: "var(--ny-radius-lg)",
          border: "1px solid var(--ny-border)",
          background: "var(--ny-surface)",
          color: "var(--ny-text-muted)",
          cursor: "pointer",
        }}
      >
        <Languages size={15} strokeWidth={2} />
      </button>
    </Popover>
  );
}
