/**
 * Sandbox registry — runtime detection and driver selection.
 *
 * Two responsibilities, kept apart on purpose:
 *
 * - {@link detectRuntimes} talks to the daemon (`docker info` → `Runtimes` +
 *   `DefaultRuntime`) and caches the answer. Impure, untestable here.
 * - {@link resolveDriver} decides which driver a request maps to, given an
 *   availability snapshot. **Pure** — no daemon, no env, no clock — which is
 *   how the fallback logic gets tested against fixture `docker info` payloads.
 *
 * The split matters beyond testing: fallback is the *common* case (gVisor is
 * absent on Docker Desktop and Podman), so the resolution has to report what
 * it fell back **from**. An invisible fallback means an operator believes they
 * have a syscall boundary they do not have. Persist requested and effective
 * separately (`agent_blueprints.sandbox_runtime` vs `agents.runtime_used`) and
 * badge the difference in the UI.
 */

import { getDockerClient } from "../lib/docker.js";
import { kataDriver } from "./kata.js";
import { runcDriver } from "./runc.js";
import { RUNSC_RUNTIME_NAME, runscDriver } from "./runsc.js";
import type { SandboxDriver, SandboxRuntimeId, SandboxRuntimeRequest } from "./types.js";

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/** Normalised view of the runtime-related fields of `docker info`. */
export interface RuntimeAvailability {
  /** Runtime names the daemon has registered, e.g. `["runc", "runsc"]`. */
  runtimes: string[];
  /** The daemon's default runtime (`DefaultRuntime`), usually `runc`. */
  defaultRuntime: string;
  /** When this snapshot was taken (ms epoch). */
  detectedAt: number;
}

/** The shape we care about out of `docker info` — everything else ignored. */
export interface DockerInfoLike {
  Runtimes?: Record<string, unknown> | null;
  DefaultRuntime?: string | null;
}

/** Pure: `docker info` payload → {@link RuntimeAvailability}. */
export function parseRuntimeAvailability(
  info: DockerInfoLike,
  detectedAt: number = Date.now(),
): RuntimeAvailability {
  return {
    runtimes: Object.keys(info?.Runtimes ?? {}),
    defaultRuntime: info?.DefaultRuntime ?? "runc",
    detectedAt,
  };
}

/**
 * Kata shim names seen in the wild. `hasKata` also does a looser substring
 * check, so this list is a fast path plus documentation of the canonical
 * spellings rather than an exhaustive registry.
 */
export const KATA_RUNTIME_NAMES = [
  "kata",
  "kata-runtime",
  "kata-qemu",
  "kata-clh",
  "kata-fc",
  "io.containerd.kata.v2",
] as const;

/**
 * Is gVisor registered? Matches `runsc` and the suffixed variants operators
 * add for tuning (`runsc-ptrace`, `runsc-kvm`, `runsc-debug`).
 */
export function hasRunsc(availability: RuntimeAvailability): boolean {
  return availability.runtimes.some(
    (name) => name === RUNSC_RUNTIME_NAME || name.startsWith(`${RUNSC_RUNTIME_NAME}-`),
  );
}

/**
 * Is any Kata shim registered? Matches the classic OCI runtime names and the
 * containerd v2 shims, including hypervisor-suffixed ones
 * (`io.containerd.kata-qemu.v2`).
 */
export function hasKata(availability: RuntimeAvailability): boolean {
  return availability.runtimes.some((name) => {
    const lower = name.toLowerCase();
    if ((KATA_RUNTIME_NAMES as readonly string[]).includes(lower)) return true;
    return lower.startsWith("kata") || lower.includes("kata");
  });
}

/** Pure: is the runtime backing `id` present in this snapshot? */
export function isRuntimeAvailable(
  id: SandboxRuntimeId,
  availability: RuntimeAvailability,
): boolean {
  switch (id) {
    case "runc":
      // If the daemon answers at all it has a default runtime. runc is the
      // terminal fallback precisely because it cannot be missing.
      return true;
    case "runsc":
      return hasRunsc(availability);
    case "kata":
      return hasKata(availability);
  }
}

// ---------------------------------------------------------------------------
// Detection (impure, cached)
// ---------------------------------------------------------------------------

/**
 * Detection TTL. Runtimes change when an operator installs gVisor and restarts
 * the daemon — rare, but we don't want to require a Blackhouse restart to
 * notice. `docker info` is cheap but not free, and agent creation would
 * otherwise call it on every request.
 */
export const RUNTIME_CACHE_TTL_MS = 60_000;

let cached: RuntimeAvailability | null = null;
let inflight: Promise<RuntimeAvailability> | null = null;

/**
 * Ask the daemon what runtimes it has, cached for {@link RUNTIME_CACHE_TTL_MS}.
 * Concurrent callers share one `docker info` round-trip.
 */
export async function detectRuntimes(
  opts: { force?: boolean; now?: number } = {},
): Promise<RuntimeAvailability> {
  const now = opts.now ?? Date.now();

  if (!opts.force && cached && now - cached.detectedAt < RUNTIME_CACHE_TTL_MS) {
    return cached;
  }
  if (!opts.force && inflight) return inflight;

  inflight = (async () => {
    const docker = await getDockerClient();
    const info = (await docker.info()) as DockerInfoLike;
    const availability = parseRuntimeAvailability(info, now);
    cached = availability;
    return availability;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

/** Drop the cached detection (tests, and after a Docker config change). */
export function resetRuntimeCache(): void {
  cached = null;
  inflight = null;
}

/** The last detection result without touching the daemon, if any. */
export function peekRuntimeCache(): RuntimeAvailability | null {
  return cached;
}

// ---------------------------------------------------------------------------
// Resolution (pure)
// ---------------------------------------------------------------------------

export interface DriverResolution {
  /** What was asked for. */
  requested: SandboxRuntimeRequest;
  /** What will actually run. */
  effective: SandboxRuntimeId;
  /**
   * Set when the effective runtime is *not* what was requested — the runtime
   * we fell back **from**. `undefined` for `auto` (which promised nothing) and
   * for an honoured request. Surface this in the UI; a silent downgrade from
   * gVisor to runc is a silent loss of the syscall boundary.
   */
  fellBackFrom?: SandboxRuntimeId;
  /** Human-readable explanation, safe to log and to show in the UI. */
  reason: string;
}

/**
 * Pure: map a requested runtime + an availability snapshot onto the driver
 * that will actually run.
 *
 * Rules:
 * - `auto` → `runsc` when gVisor is present, else `runc`. Not a "fallback":
 *   `auto` never promised gVisor, so `fellBackFrom` stays unset — but the
 *   reason still says which way it went.
 * - `runsc` → honoured when present; otherwise `runc` with
 *   `fellBackFrom: "runsc"`.
 * - `kata` → honoured when a Kata shim is present, even though the driver's
 *   `create()` throws `SandboxNotImplementedError`. Resolution answers "which
 *   driver", not "will it work"; silently swapping in runc would hand an
 *   operator who explicitly asked for a VM boundary a shared-kernel container
 *   with no error. When Kata is absent we fall back down the `auto` chain with
 *   `fellBackFrom: "kata"`.
 */
export function resolveDriver(
  requested: SandboxRuntimeRequest,
  availability: RuntimeAvailability,
): DriverResolution {
  if (requested === "auto") {
    if (hasRunsc(availability)) {
      return {
        requested,
        effective: "runsc",
        reason: "auto: gVisor (runsc) detected on this host",
      };
    }
    return {
      requested,
      effective: "runc",
      reason: "auto: gVisor (runsc) not registered with the Docker daemon; using hardened runc",
    };
  }

  if (requested === "runc") {
    return { requested, effective: "runc", reason: "runc requested" };
  }

  if (requested === "runsc") {
    if (hasRunsc(availability)) {
      return { requested, effective: "runsc", reason: "runsc requested and available" };
    }
    return {
      requested,
      effective: "runc",
      fellBackFrom: "runsc",
      reason:
        "runsc requested but gVisor is not registered with the Docker daemon " +
        "(expected on Docker Desktop and Podman); fell back to hardened runc — " +
        "this container does NOT have a gVisor syscall boundary",
    };
  }

  // kata
  if (hasKata(availability)) {
    return {
      requested,
      effective: "kata",
      reason:
        "kata requested and a Kata shim is registered — note the Kata driver is a " +
        "stub and container creation will throw SandboxNotImplementedError",
    };
  }
  if (hasRunsc(availability)) {
    return {
      requested,
      effective: "runsc",
      fellBackFrom: "kata",
      reason: "kata requested but no Kata shim is registered; fell back to runsc (gVisor)",
    };
  }
  return {
    requested,
    effective: "runc",
    fellBackFrom: "kata",
    reason:
      "kata requested but neither a Kata shim nor gVisor is registered " +
      "(Kata needs /dev/kvm — bare metal or nested virtualisation); " +
      "fell back to hardened runc",
  };
}

// ---------------------------------------------------------------------------
// Driver lookup
// ---------------------------------------------------------------------------

/**
 * The driver singleton for a runtime id.
 *
 * A `switch` rather than a module-level map on purpose: the driver modules
 * import detection helpers back out of this module, and a top-level object
 * literal would evaluate their bindings during that import cycle.
 */
export function getDriver(id: SandboxRuntimeId): SandboxDriver {
  switch (id) {
    case "runsc":
      return runscDriver;
    case "kata":
      return kataDriver;
    case "runc":
      return runcDriver;
  }
}

/** Convenience: detect, resolve, and hand back the driver plus the reasoning. */
export async function selectDriver(
  requested: SandboxRuntimeRequest,
): Promise<{ driver: SandboxDriver; resolution: DriverResolution }> {
  const availability = await detectRuntimes();
  const resolution = resolveDriver(requested, availability);
  return { driver: getDriver(resolution.effective), resolution };
}
