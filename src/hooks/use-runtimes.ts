import { useMemo } from "react";
import { client, unwrap } from "@/lib/api";
import { useResource, type Resource } from "./use-resource";

/** `GET /api/agents/runtimes` — the daemon's own view, unedited. */
export interface RuntimeAvailability {
  /** Runtime names the daemon has registered, e.g. `["runc", "runsc"]`. */
  runtimes: string[];
  /** The daemon's default runtime (`DefaultRuntime`), usually `runc`. */
  defaultRuntime: string;
  detectedAt: number;
}

export type RuntimeId = "runc" | "runsc" | "kata";

export interface RuntimeDescriptor {
  id: RuntimeId;
  /** Display name — `gVisor`, not `runsc`. */
  name: string;
  available: boolean;
  /** The daemon's own name for it, when detected. */
  detectedAs: string | null;
  isDefault: boolean;
  /** i18n key for the one-line explanation of what this buys or costs.
   *  Literal, not `string`, so `t()` keeps checking it against `en.json`. */
  noteKey: `runtimes.notes.${RuntimeId}`;
}

/**
 * Client-side twin of `hasRunsc` / `hasKata` in `server/sandbox/registry.ts`.
 *
 * Duplicated rather than imported because the server module pulls in dockerode.
 * **Keep the two in step** — the whole point of this screen is that the host's
 * real isolation is visible, and a matcher that drifts would report gVisor as
 * absent on a host that has it (or, far worse, present on one that does not).
 */
function matchRuntime(id: RuntimeId, names: string[]): string | null {
  if (id === "runc") {
    // If the daemon answered at all it has a default runtime. runc is the
    // terminal fallback precisely because it cannot be missing.
    return names.find((n) => n === "runc") ?? "runc";
  }
  if (id === "runsc") {
    // Operators add suffixed variants for tuning: runsc-ptrace, runsc-kvm.
    return names.find((n) => n === "runsc" || n.startsWith("runsc-")) ?? null;
  }
  return (
    names.find((n) => {
      const lower = n.toLowerCase();
      return lower.startsWith("kata") || lower.includes("kata");
    }) ?? null
  );
}

const TIERS: Pick<RuntimeDescriptor, "id" | "name" | "noteKey">[] = [
  { id: "runc", name: "runc", noteKey: "runtimes.notes.runc" },
  { id: "runsc", name: "gVisor", noteKey: "runtimes.notes.runsc" },
  { id: "kata", name: "Kata Containers", noteKey: "runtimes.notes.kata" },
];

/** Pure: availability snapshot → the three runtime tiers, in strength order. */
export function describeRuntimes(availability: RuntimeAvailability | null): RuntimeDescriptor[] {
  const names = availability?.runtimes ?? [];
  return TIERS.map((tier) => {
    const detectedAs = availability ? matchRuntime(tier.id, names) : null;
    return {
      id: tier.id,
      name: tier.name,
      available: detectedAs !== null,
      detectedAs,
      isDefault: detectedAs !== null && detectedAs === availability?.defaultRuntime,
      noteKey: tier.noteKey,
    };
  });
}

/** Fetch the host's runtimes and describe them in one call. */
export function useRuntimes(): Resource<RuntimeAvailability> & {
  tiers: RuntimeDescriptor[];
} {
  const resource = useResource<RuntimeAvailability>(
    async () => unwrap<RuntimeAvailability>(await client.api.agents.runtimes.$get()),
    [],
  );
  const tiers = useMemo(() => describeRuntimes(resource.data), [resource.data]);
  return { ...resource, tiers };
}
