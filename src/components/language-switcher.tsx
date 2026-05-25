import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface LangOption {
  code: string;
  label: string;
}

const LANGUAGES: LangOption[] = [
  { code: "en", label: "English" },
  { code: "zh-CN", label: "中文" },
];

/**
 * Sidebar-footer dropdown to switch the active i18n locale. Persists the
 * choice via the browser-language-detector's localStorage cache, so a
 * refresh keeps the selection.
 */
export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label={t("nav.language")}>
            <Languages className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-auto">
        {LANGUAGES.map((lang) => (
          <DropdownMenuItem
            key={lang.code}
            onClick={() => {
              void i18n.changeLanguage(lang.code);
            }}
            data-active={i18n.resolvedLanguage === lang.code || undefined}
          >
            {lang.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
