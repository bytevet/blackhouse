import { cn } from "@/lib/utils";

/**
 * Just the brand mark — a rounded square with "BH" set in the project's
 * heading font. Use this in tight chrome (sidebar header, favicon, etc).
 *
 * Renders as `currentColor` for the square and `var(--primary-foreground)` for
 * the letters, so it inherits theme and dark-mode automatically when placed
 * inside a `text-primary` (or any color) context.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("size-8 text-primary", className)}
      aria-hidden="true"
      role="img"
    >
      <rect width="32" height="32" rx="7" fill="currentColor" />
      <text
        x="16"
        y="17"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="'JetBrains Mono', ui-monospace, monospace"
        fontSize="19"
        fontWeight="700"
        letterSpacing="-1.5"
        fill="var(--primary-foreground)"
      >
        BH
      </text>
    </svg>
  );
}

/**
 * Mark + wordmark side by side. Use on the login screen and anywhere there's
 * room for the full brand. Inherits text color of the parent for the wordmark.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark className="size-8" />
      <span className="text-lg font-semibold tracking-tight">Blackhouse</span>
    </div>
  );
}
