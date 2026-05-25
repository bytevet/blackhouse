import type { PresetId } from "./agent-presets";

/**
 * DiceBear v9 SVG URL for a session's avatar. The style varies per agent
 * preset so the user can tell at a glance which kind of agent each card
 * represents; the seed makes the look deterministic.
 *
 * No npm dep, no API key — just a public URL the browser fetches as an SVG.
 */

const PRESET_STYLE: Record<PresetId, string> = {
  "claude-code": "bottts-neutral",
  antigravity: "lorelei",
  codex: "pixel-art",
  custom: "shapes",
};

const DEFAULT_STYLE = "shapes";

export function avatarUrl(seed: string, preset: string | null | undefined): string {
  const style = preset && preset in PRESET_STYLE ? PRESET_STYLE[preset as PresetId] : DEFAULT_STYLE;
  return `https://api.dicebear.com/9.x/${style}/svg?seed=${encodeURIComponent(seed)}`;
}
