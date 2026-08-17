/**
 * Sandbox abstraction — types.
 *
 * A `SandboxDriver` is "how do we run one agent container". Today every driver
 * is a Docker driver (see `docker-base.ts`); the runtime (`runc` / `runsc` /
 * `kata`) is selected per-container via `HostConfig.Runtime`, which is why
 * `attachPty` / `resizePty` / `exec` need no per-driver code at all — they sit
 * at the Docker API level, *above* the runtime. See the header of `kata.ts`.
 *
 * Nothing consumes this layer yet. It is deliberately additive groundwork:
 * `server/api/sessions.ts` still creates containers inline, and gets rewired in
 * a later phase.
 */

import type Docker from "dockerode";

// ---------------------------------------------------------------------------
// Runtime identity
// ---------------------------------------------------------------------------

/** A concrete sandbox runtime — one driver module each. */
export type SandboxRuntimeId = "runc" | "runsc" | "kata";

/**
 * What a blueprint/agent may *request*. `auto` means "best available":
 * `runsc` when the host has gVisor installed, else hardened `runc`.
 */
export type SandboxRuntimeRequest = SandboxRuntimeId | "auto";

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

/** A volume or bind mount, rendered into dockerode's `HostConfig.Binds`. */
export interface SandboxMount {
  /** Volume name (named volume) or absolute host path (bind). */
  source: string;
  /** Absolute path inside the container. */
  target: string;
  /** Mount read-only (`:ro`). Defaults to read-write. */
  readOnly?: boolean;
}

/**
 * Resource caps. All optional — `hardening.ts` fills in defaults so that a
 * spec that forgets to set them is still capped rather than unbounded.
 */
export interface SandboxResources {
  /** Hard memory limit in bytes (cgroup `memory.max`). */
  memoryBytes?: number;
  /** CPU quota in nano-CPUs; `2_000_000_000` = 2 CPUs. */
  nanoCpus?: number;
  /** Max PIDs in the container's cgroup — the fork-bomb backstop. */
  pidsLimit?: number;
}

/**
 * Where the container sits on the network. This is the one branch that has to
 * be carried faithfully out of `sessions.ts`; see the long comment in
 * `docker-base.ts#toCreateOptions`.
 */
export interface SandboxNetwork {
  /**
   * Docker network to attach to (the `BLACKHOUSE_NETWORK` env var at the call
   * site). When set, ports are reached by container IP and NOT published to
   * the host. When unset, exposed ports are published to `127.0.0.1:<ephemeral>`.
   */
  name?: string;
  /**
   * Add `host.docker.internal:host-gateway` to `ExtraHosts`.
   *
   * Defaults to `true` to match today's behaviour, but this is a direct route
   * to the host and defeats egress control (landmine 6 in the plan) — the
   * egress phase sets it `false` whenever the agent's egress mode isn't `open`.
   */
  hostGateway?: boolean;
  /**
   * Extra `/etc/hosts` entries, as `host -> ip`.
   *
   * These exist because **Docker's embedded DNS does not work under gVisor**.
   * The resolver at 127.0.0.11 is a loopback listener in the container's
   * host-side network namespace; runsc gives the sandbox its own netstack
   * (`--network=sandbox`), which never reaches it. Measured on a live host:
   * two containers on the same user-defined network, identical but for the
   * runtime — under `runc` both `app` and `example.com` resolve, under `runsc`
   * neither does and a UDP probe to 127.0.0.11 gets no reply at all.
   *
   * `/etc/hosts` needs no resolver, so pinning the few names an agent must
   * reach — the harness, and the egress proxy — makes service discovery work
   * identically under both runtimes.
   *
   * The trade-off is staleness: an entry is written at container-create time,
   * so if the harness or proxy container is recreated with a different IP,
   * running agents keep the old one until they restart.
   */
  hostAliases?: Array<{ host: string; ip: string }>;
  /**
   * Explicit nameservers for the container (Docker's `HostConfig.Dns`).
   *
   * Only supplied for runtimes where the embedded resolver is already
   * unreachable, since on other paths it would replace a working resolver and
   * cost container-name lookups.
   *
   * Note what this does *not* buy on a user-defined network: Docker keeps
   * 127.0.0.11 in resolv.conf and uses these merely as its own upstreams, so a
   * gVisor agent still cannot resolve ordinary hostnames. See
   * `server/agents/container-dns.ts` for the measurements and the open design
   * question.
   */
  dns?: string[];
}

/**
 * Everything needed to create one agent container, runtime-agnostic.
 * Deliberately a plain data object: it is built by the caller, hashed/logged
 * freely, and consumed by a pure function.
 */
export interface SandboxSpec {
  /** Image reference, e.g. `blackhouse-claude-code:latest`. */
  image: string;
  /** Optional command override; omit to use the image's `CMD`/`ENTRYPOINT`. */
  cmd?: string[];
  /** Environment, as `KEY=value` strings (matches dockerode's `Env`). */
  env?: string[];
  /** Labels — `blackhouse.managed=true` et al. Used by the reconciler. */
  labels?: Record<string, string>;
  /** Volume/bind mounts. */
  mounts?: SandboxMount[];
  /** Container-internal TCP ports to expose (9223 browser-service, 8443 IDE). */
  exposedPorts?: number[];
  /** Resource caps; see `hardening.ts` for defaults. */
  resources?: SandboxResources;
  /** Network placement + host-gateway toggle. */
  network?: SandboxNetwork;
  /** Allocate a TTY. Always true for agent CLIs — they are TUIs. */
  tty?: boolean;
  /** Keep stdin open — this is what makes prompt injection possible. */
  openStdin?: boolean;
  /** Optional working directory / user overrides. */
  workingDir?: string;
  user?: string;
}

// ---------------------------------------------------------------------------
// Handle / inspect
// ---------------------------------------------------------------------------

/**
 * An opaque reference to a created sandbox. Persisted as
 * `agents.container_id` + `agents.runtime_used`; the container id is all the
 * Docker API needs, which is why `endpoint()` can drop the DB lookup that
 * `getContainerEndpoint()` does today.
 */
export interface SandboxHandle {
  /** Docker container id. */
  id: string;
  /** Which driver created it — record this, don't re-derive it later. */
  driver: SandboxRuntimeId;
  /** Image the container was created from. */
  image?: string;
}

/** Where to reach an in-container service from the Blackhouse server. */
export interface SandboxEndpoint {
  host: string;
  port: number;
}

/** Normalised subset of `container.inspect()`. */
export interface SandboxInspect {
  id: string;
  running: boolean;
  /** Docker's status string: `created` | `running` | `exited` | ... */
  status: string;
  exitCode?: number;
  startedAt?: string;
  finishedAt?: string;
  labels: Record<string, string>;
  /** Runtime actually used by the daemon, when it reports one. */
  runtime?: string;
  /** network name → container IP on that network. */
  networks: Record<string, string>;
  /** `"9223/tcp"` → published host bindings (empty in container-network mode). */
  ports: Record<string, Array<{ hostIp: string; hostPort: string }>>;
}

/** Result of a one-shot `exec` (not the PTY path). */
export interface SandboxExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface SandboxExecOptions {
  env?: string[];
  workingDir?: string;
  user?: string;
  tty?: boolean;
}

/**
 * The hijacked attach stream: duplex, one stdin for the whole container.
 * Both browser peers and the prompt injector write here, which is why the
 * PTY hub owns it behind a mutex (landmine 4) rather than handing it out.
 */
export type SandboxPtyStream = NodeJS.ReadWriteStream & { destroyed?: boolean };

/** Terminal geometry. Docker's API is `{h, w}`; we speak cols/rows. */
export interface PtySize {
  cols: number;
  rows: number;
}

// ---------------------------------------------------------------------------
// Driver defaults (the per-runtime delta)
// ---------------------------------------------------------------------------

/**
 * The *entire* per-driver surface. A driver contributes a runtime name and a
 * `HostConfig` patch; everything else is shared. If a future driver needs more
 * than this, that's the signal the abstraction is leaking.
 */
export interface DriverDefaults {
  /**
   * `HostConfig.Runtime`. Leave `undefined` to use the daemon's default
   * runtime — `toCreateOptions` then omits the key entirely rather than
   * emitting `Runtime: undefined`.
   */
  runtime?: string;
  /** Hardening + resource flags merged over the base `HostConfig`. */
  hostConfig?: Partial<Docker.HostConfig>;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/**
 * The pluggable runtime interface. Implemented once in `docker-base.ts`;
 * `runc.ts` / `runsc.ts` / `kata.ts` only supply `DriverDefaults` and an
 * availability probe.
 */
export interface SandboxDriver {
  readonly id: SandboxRuntimeId;

  /** Is this runtime usable on this host right now? Cheap, cached upstream. */
  isAvailable(): Promise<boolean>;

  /** Pure-ish: build create options and POST them. Never starts the container. */
  create(spec: SandboxSpec): Promise<SandboxHandle>;

  start(handle: SandboxHandle): Promise<void>;
  stop(handle: SandboxHandle, opts?: { timeoutSec?: number }): Promise<void>;
  destroy(handle: SandboxHandle, opts?: { force?: boolean }): Promise<void>;

  /** Hijacked duplex attach to the container's main process (the TUI). */
  attachPty(handle: SandboxHandle): Promise<SandboxPtyStream>;
  /** The plan calls this `resize`; named for symmetry with `attachPty`. */
  resizePty(handle: SandboxHandle, size: PtySize): Promise<void>;

  exec(handle: SandboxHandle, cmd: string[], opts?: SandboxExecOptions): Promise<SandboxExecResult>;

  inspect(handle: SandboxHandle): Promise<SandboxInspect>;

  /** Resolve host:port for an in-container service (9223, 8443, ...). */
  endpoint(handle: SandboxHandle, internalPort: number): Promise<SandboxEndpoint>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

/** A driver exists as a design placeholder but cannot run containers yet. */
export class SandboxNotImplementedError extends SandboxError {
  readonly driver: SandboxRuntimeId;
  constructor(driver: SandboxRuntimeId, message: string) {
    super(message);
    this.name = "SandboxNotImplementedError";
    this.driver = driver;
  }
}

/** The requested runtime is not installed/registered on this Docker host. */
export class SandboxUnavailableError extends SandboxError {
  readonly driver: SandboxRuntimeId;
  constructor(driver: SandboxRuntimeId, message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
    this.driver = driver;
  }
}
