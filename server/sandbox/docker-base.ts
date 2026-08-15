/**
 * Sandbox abstraction — the shared dockerode implementation.
 *
 * Every driver we ship talks to the same Docker daemon; the runtime is chosen
 * per-container with `HostConfig.Runtime`. So all of the behaviour lives here
 * and the driver modules (`runc.ts`, `runsc.ts`, `kata.ts`) contribute nothing
 * but a `DriverDefaults` and an availability probe.
 *
 * The load-bearing export is {@link toCreateOptions}: it is **pure**. No Docker
 * daemon exists in CI or in the dev container, so a pure spec → create-options
 * function is the only way this entire layer gets tested. Keep it that way —
 * no `process.env` reads, no clock, no DB. Anything environmental (the
 * `BLACKHOUSE_NETWORK` value, host-gateway policy) arrives on the spec.
 */

import type Docker from "dockerode";
import { Writable } from "node:stream";
import { getDockerClient } from "../lib/docker.js";
import { hardeningHostConfig } from "./hardening.js";
import {
  type DriverDefaults,
  type PtySize,
  type SandboxDriver,
  type SandboxEndpoint,
  type SandboxExecOptions,
  type SandboxExecResult,
  type SandboxHandle,
  type SandboxInspect,
  type SandboxPtyStream,
  type SandboxRuntimeId,
  type SandboxSpec,
  SandboxError,
} from "./types.js";

// ---------------------------------------------------------------------------
// Pure: spec -> dockerode create options
// ---------------------------------------------------------------------------

/**
 * Build `docker.createContainer(...)` options from a runtime-agnostic spec.
 *
 * Lifted wholesale from `server/api/sessions.ts` (the single `createContainer`
 * call in the tree), including the network branch below, which is the part
 * that is easy to get subtly wrong.
 *
 * @param spec runtime-agnostic container description
 * @param driverDefaults the per-runtime delta: `Runtime` + a `HostConfig` patch
 */
export function toCreateOptions(
  spec: SandboxSpec,
  driverDefaults: DriverDefaults = {},
): Docker.ContainerCreateOptions {
  const networkName = spec.network?.name;

  const exposedPorts: Record<string, Record<string, never>> = {};
  for (const port of spec.exposedPorts ?? []) {
    exposedPorts[`${port}/tcp`] = {};
  }

  // Publish to the host only in host mode — see the block comment below.
  const portBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
  for (const port of spec.exposedPorts ?? []) {
    portBindings[`${port}/tcp`] = [{ HostIp: "127.0.0.1", HostPort: "" }];
  }

  const binds = (spec.mounts ?? []).map((m) => `${m.source}:${m.target}${m.readOnly ? ":ro" : ""}`);

  // Default true to preserve today's behaviour. The egress phase flips this
  // off for non-`open` agents — `host.docker.internal:host-gateway` is a
  // direct route to the host and defeats any egress policy (plan landmine 6).
  const hostGateway = spec.network?.hostGateway ?? true;

  const hostConfig: Docker.HostConfig = {
    Binds: binds.length > 0 ? binds : undefined,
    ExtraHosts: hostGateway ? ["host.docker.internal:host-gateway"] : undefined,

    // Container-network mode reaches services by container IP, so publishing
    // to the host would be pointless surface area.
    PortBindings: networkName || Object.keys(portBindings).length === 0 ? undefined : portBindings,

    // Fail-safe baseline: apply hardening here too, so a spec that reaches
    // this function with empty `driverDefaults` is still capped and
    // capability-stripped rather than running with Docker's permissive
    // defaults. Every shipped driver re-supplies this patch (with its own
    // options), and being last, the driver's version wins.
    ...hardeningHostConfig(spec.resources),

    ...(driverDefaults.hostConfig ?? {}),
  };

  // Omit the key entirely when the driver wants the daemon default, so that
  // `"Runtime" in HostConfig` is false for runc rather than
  // `Runtime: undefined`. Tests assert on absence.
  if (driverDefaults.runtime !== undefined) {
    hostConfig.Runtime = driverDefaults.runtime;
  }

  return {
    Image: spec.image,
    Cmd: spec.cmd,
    Env: spec.env,
    // TUI agents: a TTY plus a stdin that stays open. The open stdin is not
    // cosmetic — it is the prompt-injection path (`container.attach`).
    Tty: spec.tty ?? true,
    OpenStdin: spec.openStdin ?? true,
    WorkingDir: spec.workingDir,
    User: spec.user,
    Labels: spec.labels,

    // Expose the in-container services so the Blackhouse server can
    // proxy them to the React SPA:
    //   9223 — browser-service (Playwright screencast + control)
    //   8443 — code-server (IDE)
    // Reachability is decided by whether a network name is set
    // (see `getContainerEndpoint` in `server/lib/docker.ts`, and `endpoint()`
    // below — the caller passes `process.env.BLACKHOUSE_NETWORK`):
    //
    // - Set: Blackhouse runs inside its own container; the agent
    //   attaches to the same Docker network and we reach it by its
    //   IP on that network + the internal port. No host port mapping.
    //
    // - Unset: local-dev path. Blackhouse runs on the host; agent
    //   binds to the host's `127.0.0.1:<ephemeral>`, constrained to
    //   the loopback so the services aren't exposed on the LAN.
    ExposedPorts: Object.keys(exposedPorts).length > 0 ? exposedPorts : undefined,
    NetworkingConfig: networkName ? { EndpointsConfig: { [networkName]: {} } } : undefined,

    HostConfig: hostConfig,
  };
}

// ---------------------------------------------------------------------------
// Shared driver implementation
// ---------------------------------------------------------------------------

const ATTACH_ATTEMPTS = 3;
const ATTACH_RETRY_MS = 2000;

/**
 * Short-lived endpoint cache, same rationale (and TTL) as the one in
 * `server/lib/docker.ts`: browser/IDE flows hit this several times per user
 * gesture and each miss costs a `container.inspect()` round-trip. The endpoint
 * is immutable for a container's lifetime, so staleness is only a concern
 * after destroy — hence {@link invalidateEndpointCache}.
 */
const ENDPOINT_TTL_MS = 5_000;
const endpointCache = new Map<string, { endpoint: SandboxEndpoint; expires: number }>();

/** Drop cached endpoint lookups for a container. Call after destroy. */
export function invalidateEndpointCache(containerId: string): void {
  for (const key of endpointCache.keys()) {
    if (key.startsWith(`${containerId}:`)) endpointCache.delete(key);
  }
}

/**
 * Base class for the Docker-backed drivers. Subclasses supply an id, a
 * `defaults(spec)` (the per-runtime delta), and an availability probe.
 */
export abstract class DockerSandboxDriver implements SandboxDriver {
  abstract readonly id: SandboxRuntimeId;

  /** The per-runtime delta. This is the whole of a driver's behaviour. */
  protected abstract defaults(spec: SandboxSpec): DriverDefaults;

  abstract isAvailable(): Promise<boolean>;

  /**
   * Pure: the create options this driver would send for `spec`. Exposed so
   * tests can assert on the payload without a daemon.
   */
  buildCreateOptions(spec: SandboxSpec): Docker.ContainerCreateOptions {
    return toCreateOptions(spec, this.defaults(spec));
  }

  protected async docker(): Promise<Docker> {
    return getDockerClient();
  }

  protected async container(handle: SandboxHandle): Promise<Docker.Container> {
    const docker = await this.docker();
    return docker.getContainer(handle.id);
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const docker = await this.docker();
    const container = await docker.createContainer(this.buildCreateOptions(spec));
    return { id: container.id, driver: this.id, image: spec.image };
  }

  async start(handle: SandboxHandle): Promise<void> {
    const container = await this.container(handle);
    await container.start();
  }

  async stop(handle: SandboxHandle, opts: { timeoutSec?: number } = {}): Promise<void> {
    const container = await this.container(handle);
    try {
      await container.stop({ t: opts.timeoutSec ?? 10 });
    } catch (err) {
      // Already stopped is not a failure — dockerode surfaces this as a 304.
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("is not running") && !message.includes("304")) throw err;
    }
  }

  async destroy(handle: SandboxHandle, opts: { force?: boolean } = {}): Promise<void> {
    const container = await this.container(handle);
    try {
      await container.remove({ force: opts.force ?? true, v: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Gone already — destroy is idempotent by design (the reconciler calls it).
      if (!message.includes("No such container") && !message.includes("404")) throw err;
    } finally {
      invalidateEndpointCache(handle.id);
    }
  }

  /**
   * Hijacked attach to the container's main process — this is the TUI.
   *
   * Lifted from `server/ws/terminal.ts`: three attempts with a 2s pause,
   * because a container that has just been started can reject the attach
   * before its process is up.
   *
   * Needs **zero** per-driver code: attach is a Docker API operation that sits
   * above the runtime.
   */
  async attachPty(handle: SandboxHandle): Promise<SandboxPtyStream> {
    const container = await this.container(handle);

    let stream: SandboxPtyStream | null = null;
    let lastErr: unknown;

    for (let attempt = 0; attempt < ATTACH_ATTEMPTS; attempt++) {
      try {
        stream = (await container.attach({
          stream: true,
          stdin: true,
          stdout: true,
          stderr: true,
          hijack: true,
        })) as unknown as SandboxPtyStream;
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < ATTACH_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, ATTACH_RETRY_MS));
        }
      }
    }

    if (lastErr || !stream) {
      throw lastErr instanceof Error
        ? lastErr
        : new SandboxError(`Failed to attach to container ${handle.id}`);
    }
    return stream;
  }

  /** Also runtime-agnostic: `POST /containers/:id/resize`. */
  async resizePty(handle: SandboxHandle, size: PtySize): Promise<void> {
    const container = await this.container(handle);
    await container.resize({ h: size.rows, w: size.cols });
  }

  async exec(
    handle: SandboxHandle,
    cmd: string[],
    opts: SandboxExecOptions = {},
  ): Promise<SandboxExecResult> {
    const docker = await this.docker();
    const container = docker.getContainer(handle.id);

    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      Tty: opts.tty ?? false,
      Env: opts.env,
      WorkingDir: opts.workingDir,
      User: opts.user,
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    let stdout = "";
    let stderr = "";
    const out = new Writable({
      write(chunk, _enc, cb) {
        stdout += chunk.toString("utf-8");
        cb();
      },
    });
    const err = new Writable({
      write(chunk, _enc, cb) {
        stderr += chunk.toString("utf-8");
        cb();
      },
    });

    if (opts.tty) {
      // A TTY exec is not multiplexed — raw bytes on one stream.
      stream.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
      });
    } else {
      docker.modem.demuxStream(stream, out, err);
    }

    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
    });

    const info = await exec.inspect();
    return { exitCode: info.ExitCode ?? null, stdout, stderr };
  }

  async inspect(handle: SandboxHandle): Promise<SandboxInspect> {
    const container = await this.container(handle);
    const info = await container.inspect();

    const networks: Record<string, string> = {};
    for (const [name, net] of Object.entries(info.NetworkSettings?.Networks ?? {})) {
      const ip = (net as { IPAddress?: string })?.IPAddress;
      if (ip) networks[name] = ip;
    }

    const ports: SandboxInspect["ports"] = {};
    for (const [key, bindings] of Object.entries(info.NetworkSettings?.Ports ?? {})) {
      ports[key] = (bindings ?? []).map((b) => ({
        hostIp: b.HostIp,
        hostPort: b.HostPort,
      }));
    }

    return {
      id: info.Id,
      running: Boolean(info.State?.Running),
      status: info.State?.Status ?? "unknown",
      exitCode: info.State?.ExitCode,
      startedAt: info.State?.StartedAt,
      finishedAt: info.State?.FinishedAt,
      labels: info.Config?.Labels ?? {},
      runtime: (info.HostConfig as { Runtime?: string } | undefined)?.Runtime,
      networks,
      ports,
    };
  }

  /**
   * `getContainerEndpoint()` from `server/lib/docker.ts` with the DB lookup
   * dropped — the handle already carries the container id.
   *
   * Two reachability modes, unchanged:
   *
   * 1. **Container-network mode** (`networkName` given, i.e. the caller's
   *    `BLACKHOUSE_NETWORK` is set, used by `compose.yml`): Blackhouse runs
   *    inside its own container, so the host's loopback is NOT reachable as
   *    `127.0.0.1` from here. The agent is attached to the same Docker network
   *    (see `toCreateOptions`), so we reach it by the agent's IP on that
   *    network + its INTERNAL port. No host port mapping needed; the request
   *    never leaves Docker.
   *
   * 2. **Host mode** (default — local dev: `npm run dev` on the host):
   *    `127.0.0.1` IS the host's loopback, so we reach the agent via the
   *    ephemeral host port Docker mapped to its internal port (per the
   *    `PortBindings` block in `toCreateOptions`).
   */
  async endpoint(
    handle: SandboxHandle,
    internalPort: number,
    networkName: string | undefined = process.env.BLACKHOUSE_NETWORK,
  ): Promise<SandboxEndpoint> {
    const cacheKey = `${handle.id}:${internalPort}`;
    const hit = endpointCache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return hit.endpoint;

    const container = await this.container(handle);
    const info = await container.inspect();

    let endpoint: SandboxEndpoint;

    if (networkName) {
      const ip = info.NetworkSettings?.Networks?.[networkName]?.IPAddress;
      if (!ip) {
        throw new SandboxError(
          `Container ${handle.id} is not attached to network "${networkName}" ` +
            `(BLACKHOUSE_NETWORK is set). NetworkSettings.Networks keys: ` +
            `${Object.keys(info.NetworkSettings?.Networks ?? {}).join(", ") || "<none>"}`,
        );
      }
      endpoint = { host: ip, port: internalPort };
    } else {
      const key = `${internalPort}/tcp`;
      const bindings = info.NetworkSettings?.Ports?.[key];
      if (!bindings || bindings.length === 0 || !bindings[0].HostPort) {
        throw new SandboxError(`Container ${handle.id} has no host binding for ${key}`);
      }
      const port = Number(bindings[0].HostPort);
      if (!Number.isFinite(port)) {
        throw new SandboxError(`Container ${handle.id} returned non-numeric HostPort for ${key}`);
      }
      endpoint = { host: "127.0.0.1", port };
    }

    endpointCache.set(cacheKey, { endpoint, expires: Date.now() + ENDPOINT_TTL_MS });
    return endpoint;
  }
}
