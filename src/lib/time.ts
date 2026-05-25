import i18n from "@/i18n";

/**
 * Locale-aware relative time formatter. Uses `Intl.RelativeTimeFormat` so
 * zh-CN (and any future locale) gets correct phrasing for free ("5分钟前",
 * "il y a 3 heures", etc.) without per-locale strings in our JSON.
 *
 * Falls back gracefully on environments without `Intl.RelativeTimeFormat`
 * (none of our target browsers actually lack it, but defensive cheap).
 */
export function timeAgo(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const diffSec = Math.floor((now - then) / 1000);

  const lang = i18n.resolvedLanguage || i18n.language || "en";
  if (typeof Intl === "undefined" || typeof Intl.RelativeTimeFormat === "undefined") {
    return fallback(diffSec);
  }
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });

  // Pick the largest unit that yields an integer ≥ 1; rtf wants a negative
  // number for "in the past", positive for the future.
  if (diffSec < 60) return rtf.format(-Math.max(diffSec, 0), "second");
  const minutes = Math.floor(diffSec / 60);
  if (minutes < 60) return rtf.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 30) return rtf.format(-days, "day");
  const months = Math.floor(days / 30);
  return rtf.format(-months, "month");
}

function fallback(seconds: number): string {
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
