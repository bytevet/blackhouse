/**
 * `runsc` driver — gVisor. The default on Linux hosts that have it installed.
 *
 * gVisor runs a user-space kernel (the Sentry) between the container and the
 * host: the workload's syscalls are serviced by Go code, and only a small,
 * fixed set of host syscalls is ever issued. That is a genuinely different
 * boundary from runc's "same kernel, fewer capabilities".
 *
 * ## The delta from runc, in full
 *
 * ```
 *   HostConfig.Runtime = "runsc"     // runc leaves this unset
 * ```
 *
 * That is it. Everything else — labels, ports, binds, caps, pids, tmpfs,
 * attach, resize, exec — is identical, because runtime selection happens at
 * the Docker API level and the rest of the API sits above it. If this file
 * ever grows a second meaningful difference, that is a signal the abstraction
 * is leaking.
 *
 * ## Why there is no custom seccomp profile here
 *
 * The instinct is "stronger isolation deserves a stricter syscall filter". It
 * is backwards. **gVisor _is_ the syscall filter** — the workload's syscalls
 * never reach the host kernel directly, so a host-side seccomp profile is
 * filtering the Sentry's own (small, already-minimal) syscall usage, not the
 * agent's. Stacking a restrictive profile on runsc produces `ENOSYS` failures
 * from inside the Sentry with no useful attribution: an agent's `npm install`
 * fails with an error message that points at neither the profile nor the
 * runtime. We pass no `seccomp=` SecurityOpt and let Docker's default apply.
 *
 * ## Known rough edges (verify on a real Linux host — no daemon exists here)
 *
 * - **Chromium.** `agent/browser-service/service.mjs` drives Playwright
 *   Chromium, which is the workload most likely to misbehave under gVisor:
 *   it generally needs `--no-sandbox` (its own sandbox uses namespace and
 *   seccomp tricks the Sentry doesn't implement) and runs measurably slower.
 *   Verify before making runsc the default for browser-enabled blueprints.
 * - Syscall coverage is very good but not total; exotic tooling (eBPF,
 *   `io_uring` on older gVisor, some `ptrace` use) can fail.
 * - I/O through the gofer is slower than a native bind mount, which shows up
 *   in `npm install`-shaped workloads.
 */

import { DockerSandboxDriver } from "./docker-base.js";
import { hardeningHostConfig } from "./hardening.js";
import { detectRuntimes, hasRunsc } from "./registry.js";
import type { DriverDefaults, SandboxRuntimeId, SandboxSpec } from "./types.js";

/** The runtime name gVisor registers with the Docker daemon. */
export const RUNSC_RUNTIME_NAME = "runsc";

/** Pure: the per-runtime delta for runsc. Exported for tests. */
export function runscDefaults(spec: SandboxSpec): DriverDefaults {
  return {
    // >>> The entire difference between this driver and runc.ts. <<<
    runtime: RUNSC_RUNTIME_NAME,
    // Identical hardening to runc — caps/pids/tmpfs still apply, they are
    // enforced by the Sentry rather than the host kernel. Note the absent
    // `seccompProfilePath`: see the header.
    hostConfig: hardeningHostConfig(spec.resources),
  };
}

class RunscDriver extends DockerSandboxDriver {
  readonly id: SandboxRuntimeId = "runsc";

  protected defaults(spec: SandboxSpec): DriverDefaults {
    return runscDefaults(spec);
  }

  /** Present iff the daemon reports a `runsc` entry in `docker info`. */
  async isAvailable(): Promise<boolean> {
    try {
      return hasRunsc(await detectRuntimes());
    } catch {
      return false;
    }
  }
}

export const runscDriver = new RunscDriver();
