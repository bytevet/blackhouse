/**
 * `kata` driver — Kata Containers. **Not implemented in v1**; this is a
 * designed-for future, and the stub exists to prove the interface generalises
 * past a shared-kernel boundary.
 *
 * Kata gives each container a real VM (QEMU/Cloud-Hypervisor/Firecracker) with
 * its own guest kernel, so the isolation boundary is hardware virtualisation
 * rather than kernel namespaces. It requires `/dev/kvm` on the host — which
 * means bare metal or a VPS with nested virtualisation enabled; it will not
 * work on Docker Desktop for macOS, and detection will simply report absent.
 *
 * ## What a VM boundary changes (the reason this stub earns its place)
 *
 * 1. **`Memory` stops being a cgroup limit and becomes VM RAM allocation.**
 *    Under runc/runsc a 2 GB `Memory` is a ceiling the workload rarely touches;
 *    the kernel overcommits and unused memory costs nothing. Under Kata it is
 *    *allocated to the guest*, plus per-VM overhead (~130 MB for the VMM and
 *    guest kernel). Ten idle agents at 2 GB is 20+ GB genuinely consumed. So
 *    the defaults in `hardening.ts` are wrong here — a Kata driver must ship
 *    smaller defaults and rely on guest memory hotplug for burst, and
 *    `NanoCpus` similarly maps onto vCPU count rather than a CFS quota.
 *
 * 2. **Binds traverse virtio-fs, and mtime semantics differ.** Host paths are
 *    shared into the guest through virtiofsd, not bind-mounted. Attribute
 *    caching (`cache=auto`) means a file's `mtime`/size as seen in the guest
 *    can lag the host by the cache timeout, and sub-second timestamp
 *    granularity is not guaranteed to round-trip. **This matters directly for
 *    us**: the sidecar tails the `.jsonl` transcripts under
 *    `~/.claude/projects` by polling for
 *    size/mtime deltas (deliberately, since inotify is unreliable over
 *    overlayfs). A lagging attribute cache turns "poll at 500ms" into
 *    "transcript arrives in bursts", and the idle/busy heuristic that gates
 *    prompt injection reads directly off that quiet period. A Kata
 *    implementation must either mount the state volume with cache disabled or
 *    move the sidecar's watermark signal off the filesystem.
 *
 * 3. **`host.docker.internal:host-gateway` is meaningless.** The guest has its
 *    own network namespace behind a tap device; there is no host gateway to
 *    alias. Anything that reaches the harness via that name must instead go
 *    through the Docker network (`BLACKHOUSE_NETWORK`), which is the mode we
 *    want under an egress policy anyway — so a Kata driver would set
 *    `network.hostGateway = false` unconditionally.
 *
 * 4. **Caps, `PidsLimit` and `no-new-privileges` are enforced in the guest.**
 *    They still apply, but they are now defence-in-depth *inside* a VM rather
 *    than the primary boundary — a capability escalation in the guest buys the
 *    attacker guest root, not host root. Their failure mode changes from
 *    "compromise" to "annoyance", which is an argument for keeping them, not
 *    dropping them.
 *
 * ## And the observation that says the interface holds
 *
 * **`attachPty`, `resizePty` and `exec` need zero per-driver code.** They are
 * Docker API operations (`/containers/:id/attach`, `/resize`, `/exec`) that sit
 * *above* the runtime: the daemon proxies them into the sandbox whether the
 * process lives in a namespace (runc), a user-space kernel (runsc), or a
 * virtual machine (kata). The TUI attach — the single most load-bearing
 * mechanism in this harness, since prompt injection rides on it — is
 * runtime-agnostic by construction. That is why a VM-backed driver is
 * plausibly a `DriverDefaults` object and a mount-policy tweak, not a rewrite.
 */

import { DockerSandboxDriver } from "./docker-base.js";
import { hardeningHostConfig } from "./hardening.js";
import { detectRuntimes, hasKata } from "./registry.js";
import {
  SandboxNotImplementedError,
  type DriverDefaults,
  type SandboxHandle,
  type SandboxRuntimeId,
  type SandboxSpec,
} from "./types.js";

export { SandboxNotImplementedError };

/**
 * Runtime names Kata registers with Docker, depending on the install path:
 * the classic OCI shim (`kata-runtime`, `kata`) or the containerd v2 shim
 * (`io.containerd.kata.v2`, plus hypervisor-suffixed variants like
 * `io.containerd.kata-qemu.v2`).
 */
export const KATA_RUNTIME_NAMES = ["kata", "kata-runtime", "io.containerd.kata.v2"] as const;

/**
 * Pure: what the delta *would* be. Kept honest — the runtime name is real and
 * detection uses it — but `create()` still refuses, because shipping the
 * defaults above without the memory and virtio-fs work would produce agents
 * that boot and then fail confusingly.
 */
export function kataDefaults(spec: SandboxSpec): DriverDefaults {
  return {
    runtime: "kata-runtime",
    hostConfig: hardeningHostConfig(spec.resources),
  };
}

class KataDriver extends DockerSandboxDriver {
  readonly id: SandboxRuntimeId = "kata";

  protected defaults(spec: SandboxSpec): DriverDefaults {
    return kataDefaults(spec);
  }

  /**
   * A genuine probe, not a `return false`: we ask the daemon which runtimes it
   * has registered and look for any Kata shim. A host *can* report available
   * here — `create()` is what refuses, so the UI can honestly say "your host
   * supports Kata; Blackhouse doesn't yet".
   */
  async isAvailable(): Promise<boolean> {
    try {
      return hasKata(await detectRuntimes());
    } catch {
      return false;
    }
  }

  async create(_spec: SandboxSpec): Promise<SandboxHandle> {
    throw new SandboxNotImplementedError(
      "kata",
      "The Kata sandbox driver is not implemented. A VM boundary changes memory " +
        "accounting (Memory becomes allocated VM RAM, not a cgroup ceiling), mount " +
        "semantics (binds traverse virtio-fs, with attribute-cache lag the sidecar's " +
        "file tailing depends on), and networking (host-gateway does not exist in the " +
        "guest) — see the header of server/sandbox/kata.ts. Use 'runsc' (gVisor) or " +
        "'runc' instead.",
    );
  }
}

export const kataDriver = new KataDriver();
