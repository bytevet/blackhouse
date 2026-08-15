/**
 * Sandbox hardening — the `HostConfig` flags every driver applies.
 *
 * Agents run untrusted, model-authored code. The container boundary is the
 * only thing between that code and the host, so this file is where we spend
 * the isolation budget. Every flag below is annotated with **what it breaks**,
 * because a hardening default that silently bricks `npm install` gets reverted
 * in anger three weeks later instead of being tuned.
 *
 * This module is pure and daemon-free: it takes resources, returns a
 * `Partial<Docker.HostConfig>`. That is what makes it testable without Docker.
 */

import type Docker from "dockerode";
import type { SandboxResources } from "./types.js";

/** 2 GB — matches what `sessions.ts` has shipped with. */
export const DEFAULT_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
/** 2 CPUs, in nano-CPUs. */
export const DEFAULT_NANO_CPUS = 2_000_000_000;
/**
 * PIDs cap. Docker's default is unlimited, which means a single `while :; do
 * :& done` in agent-authored code takes down the *host*, not just the agent.
 * 512 is generous for node + a package manager + a Chromium tree; a real build
 * of a large monorepo can approach it, so it is per-blueprint tunable.
 */
export const DEFAULT_PIDS_LIMIT = 512;

/**
 * tmpfs size for `/tmp`. Deliberately modest: **tmpfs pages are charged to the
 * container's memory cgroup**, so a 2 GB `Memory` cap with a 1 GB `/tmp` is a
 * 1 GB agent that OOMs mysteriously. Sized to fit a package-manager unpack.
 */
export const DEFAULT_TMP_SIZE = "512m";
/** `/run` holds pid files and sockets; kilobytes in practice. */
export const DEFAULT_RUN_SIZE = "64m";

/**
 * Capabilities the agent keeps after `CapDrop: ['ALL']`.
 *
 * Everything not on this list is gone, including the ones people assume are
 * free: `NET_RAW` (no `ping`, no raw sockets), `SYS_PTRACE` (no `strace`, no
 * `gdb`, no attaching a debugger to another process), `SYS_ADMIN` (no mount,
 * no user namespaces — so nested Docker/`unshare`-based sandboxes fail),
 * `NET_BIND_SERVICE` (no binding ports < 1024; our services are 8443/9223 so
 * this is fine, but an agent told to "serve it on port 80" cannot),
 * `AUDIT_WRITE` (`su`/`login` fail), `MKNOD`, `SYS_TIME`, `SYS_MODULE`.
 */
export const MINIMAL_CAP_ADD: readonly string[] = [
  // Package managers unpack archives that carry ownership metadata, and
  // `npm`/`pip` chown their caches and global prefixes.
  "CHOWN",
  // Dropping privileges: `npm` refuses to run lifecycle scripts as root and
  // re-execs them as `nobody`; `su`/`gosu` in entrypoints need these two.
  "SETUID",
  "SETGID",
  // Reading/writing files whose mode says otherwise — mounted volumes come
  // back with host uids that don't match the in-container user constantly.
  "DAC_OVERRIDE",
  // Operating on files you don't own: `tar -x` restoring mtimes, `chmod` on
  // extracted node_modules binaries, `rm -rf` of a mixed-ownership tree.
  "FOWNER",
  // NOTE: the plan's prose lists five caps and omits KILL. It is included
  // deliberately: agent CLIs spawn child processes (test runners, dev servers,
  // language servers) under one uid and signal them from another after a
  // SETUID drop — without CAP_KILL those signals fail with EPERM and the agent
  // accumulates orphaned processes until it hits PidsLimit. Cheap to grant:
  // CAP_KILL only permits signalling processes inside this PID namespace.
  "KILL",
];

/**
 * `no-new-privileges` blocks setuid binaries and file capabilities from
 * *raising* privileges after exec — a setuid-root helper in the image (or one
 * the agent builds) can no longer escalate.
 *
 * Breaks: `sudo`, `su`, `newgrp`, `ping` on distros that ship it setuid, and
 * anything that relies on file capabilities (`setcap cap_net_bind_service` on
 * a node binary). Agent images run as a normal user and never need to
 * escalate — if an image *does*, that is a bug in the image.
 */
export const SECURITY_OPT_NO_NEW_PRIVILEGES = "no-new-privileges:true";

export interface HardeningOptions {
  /**
   * Path to a custom seccomp profile, rendered as `seccomp=<path>`.
   *
   * **Leave unset for `runsc`** — gVisor already interposes on every syscall;
   * stacking a restrictive host seccomp profile on top produces opaque ENOSYS
   * failures deep inside the Sentry that are near-impossible to attribute.
   * See `runsc.ts`. Unset means Docker's default profile applies, which is
   * what we want everywhere in v1.
   */
  seccompProfilePath?: string;
  /**
   * `ReadonlyRootfs`. **Stays `false` in v1** (plan, risk 2): agents run `apt`,
   * `pip`, `npm install`, and code-server extension installs constantly, all
   * of which write outside the mounted workspace. Turning this on without
   * first enumerating every writable path breaks images in non-obvious ways
   * ("nothing starts" is not "hardened"). Exposed here so Phase 8 can flip it
   * per-agent once those paths are tmpfs-mounted.
   */
  readonlyRootfs?: boolean;
  /** Override the tmpfs sizes. */
  tmpSize?: string;
  runSize?: string;
}

/**
 * tmpfs mounts.
 *
 * **Deliberately no `noexec`.** The obvious hardening move is
 * `rw,noexec,nosuid,nodev`, and it breaks the primary workload: `npm` unpacks
 * and runs lifecycle scripts and prebuilt binaries out of `/tmp`, `pip`
 * builds wheels there, and `go build` / `cc` write and execute temporary
 * objects. `noexec` on `/tmp` turns all of that into `EACCES`. `nosuid` and
 * `nodev` are kept — they cost nothing.
 *
 * These are also *not* about isolation so much as blast radius: a tmpfs `/tmp`
 * means junk never lands on the image layer and dies with the container.
 */
export function hardeningTmpfs(opts: HardeningOptions = {}): Record<string, string> {
  return {
    "/tmp": `rw,nosuid,nodev,size=${opts.tmpSize ?? DEFAULT_TMP_SIZE}`,
    "/run": `rw,nosuid,nodev,size=${opts.runSize ?? DEFAULT_RUN_SIZE}`,
  };
}

/** Resolve resource caps, filling in defaults for anything the spec omitted. */
export function resolveResources(resources: SandboxResources = {}): Required<SandboxResources> {
  return {
    memoryBytes: resources.memoryBytes ?? DEFAULT_MEMORY_BYTES,
    nanoCpus: resources.nanoCpus ?? DEFAULT_NANO_CPUS,
    pidsLimit: resources.pidsLimit ?? DEFAULT_PIDS_LIMIT,
  };
}

/**
 * The full hardening patch, merged over the base `HostConfig` by
 * `toCreateOptions`. Pure — no daemon, no env, no clock.
 */
export function hardeningHostConfig(
  resources: SandboxResources = {},
  opts: HardeningOptions = {},
): Partial<Docker.HostConfig> {
  const limits = resolveResources(resources);

  const securityOpt = [SECURITY_OPT_NO_NEW_PRIVILEGES];
  if (opts.seccompProfilePath) {
    securityOpt.push(`seccomp=${opts.seccompProfilePath}`);
  }

  return {
    // Drop the whole ambient set, then add back the six below. Docker's
    // default set includes NET_RAW, MKNOD, SETPCAP, SYS_CHROOT and friends —
    // none of which an agent CLI needs, and each of which is a rung on a
    // privilege-escalation ladder.
    CapDrop: ["ALL"],
    CapAdd: [...MINIMAL_CAP_ADD],
    SecurityOpt: securityOpt,

    // Fork-bomb / runaway-parallelism backstop.
    PidsLimit: limits.pidsLimit,

    // Resource caps. Under runc these are cgroup limits and the kernel
    // overcommits happily; under Kata `Memory` becomes VM RAM (see kata.ts).
    Memory: limits.memoryBytes,
    NanoCpus: limits.nanoCpus,

    Tmpfs: hardeningTmpfs(opts),

    // See HardeningOptions.readonlyRootfs — false in v1, on purpose.
    ReadonlyRootfs: opts.readonlyRootfs ?? false,
  };
}
