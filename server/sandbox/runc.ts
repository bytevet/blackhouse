/**
 * `runc` driver — the default OCI runtime, plus full hardening.
 *
 * This is the fallback everywhere: it is what Docker Desktop, Podman, and any
 * Linux host without gVisor installed will actually run. The isolation
 * boundary here is the kernel's own (namespaces + cgroups + seccomp + caps),
 * so the hardening in `hardening.ts` is doing all of the work — a container
 * escape under runc is a host compromise.
 *
 * Runtime: **unset**. We deliberately do not send `HostConfig.Runtime: "runc"`;
 * we send nothing and let the daemon use its configured default. Pinning the
 * literal string would break hosts whose default runtime is named something
 * else (`crun` on Podman, for instance) for no benefit.
 */

import { DockerSandboxDriver } from "./docker-base.js";
import { hardeningHostConfig } from "./hardening.js";
import type { DriverDefaults, SandboxRuntimeId, SandboxSpec } from "./types.js";

/** Pure: the per-runtime delta for runc. Exported for tests. */
export function runcDefaults(spec: SandboxSpec): DriverDefaults {
  return {
    // Undefined on purpose — `toCreateOptions` then omits the key entirely.
    runtime: undefined,
    // Full hardening. No custom seccomp profile in v1: Docker's default
    // profile already blocks ~44 syscalls, and a bespoke profile is a
    // maintenance burden we can't validate without a daemon here.
    hostConfig: hardeningHostConfig(spec.resources),
  };
}

class RuncDriver extends DockerSandboxDriver {
  readonly id: SandboxRuntimeId = "runc";

  protected defaults(spec: SandboxSpec): DriverDefaults {
    return runcDefaults(spec);
  }

  /**
   * Always available: if Docker answers at all, it has a default runtime.
   * This is why runc is the terminal fallback in `resolveDriver`.
   */
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

export const runcDriver = new RuncDriver();
