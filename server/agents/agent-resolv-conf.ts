/**
 * A working `/etc/resolv.conf` for agents under a runtime with no embedded DNS.
 *
 * ## The failure this exists for
 *
 * Under gVisor an agent had no name resolution at all, so the Claude Code CLI
 * printed `Failed to connect to api.anthropic.com: ETIMEOUT` and exited — and
 * because `entrypoint.sh` execs the CLI, the CLI exiting kills the container.
 * From the UI it looked like "the agent will not start".
 *
 * Measured on a live gVisor host, runs identical but for the flags:
 *
 *   1. runc  + `--network blackhouse`, curl api.anthropic.com  → 405 (reachable)
 *   2. runsc + `--network blackhouse --dns 1.1.1.1`, same curl → could not resolve host
 *   3. runsc + `--network blackhouse`, cat resolv.conf         → nameserver 127.0.0.11
 *   4. runsc on the DEFAULT bridge, cat resolv.conf            → nameserver 1.1.1.1
 *   5. runsc, writing resolv.conf from inside the container    → Permission denied
 *   6. runsc + a host file bind-mounted at resolv.conf         → 405 (works)
 *
 * (2) against (3) is the load-bearing pair. Attaching a container to a
 * *user-defined* network makes Docker write `nameserver 127.0.0.11` into
 * resolv.conf no matter what, and demote `HostConfig.Dns` to mere upstreams of
 * that embedded resolver. A runsc sandbox has its own netstack and never
 * reaches 127.0.0.11, so `HostConfig.Dns` is inert in every deployment that
 * sets `BLACKHOUSE_NETWORK` — which is every real one, `compose.yml` included.
 * It looked like a mitigation and did nothing. (5) rules out fixing this from
 * the entrypoint: Docker bind-mounts resolv.conf read-only and the agent images
 * drop to a non-root user anyway.
 *
 * (6) is the remedy, and this module is that remedy: put a real resolv.conf on
 * the Docker host and bind-mount it over the container's.
 *
 * ## Why a helper container writes the file instead of `fs.writeFile`
 *
 * A bind source is resolved **by the daemon, on the daemon's filesystem**. The
 * harness runs as a container (`bh-app`) whose only mount is the Docker socket,
 * and the daemon need not even be local — `docker_configs` supports a TCP
 * daemon, in which case the correct filesystem is another machine's. Writing
 * the file from this process would land in the app container's own overlay,
 * where the daemon cannot see it; Docker would then *create* the missing bind
 * source as an empty directory and mount a directory over `/etc/resolv.conf`,
 * which leaves the agent worse off than the bug being fixed.
 *
 * With the socket as the only tool, the one way to put a byte on the daemon's
 * filesystem is to run a container that has it mounted. So: one short-lived
 * container, no network, root user (the agent images drop to a non-root user
 * that cannot write into a root-owned bind), removed in a `finally`, run at
 * most once per configuration per process.
 *
 * ## Design choice: seed by default, operator override wins
 *
 * Option (a) — an operator-supplied path only — was rejected as the sole
 * mechanism because gVisor is what `auto` *selects* on a Linux host with runsc
 * registered. Shipping a default that resolves nothing until an operator reads
 * a log line and hand-writes a file makes the recommended isolation setting the
 * broken one. So the file is seeded (option b), `BLACKHOUSE_AGENT_RESOLV_CONF`
 * overrides it for operators with their own resolver, and every path that ends
 * without a usable resolver warns loudly rather than throwing: no DNS is a
 * degraded agent, but refusing to start is a dead one.
 */

import path from "node:path";
import { getDockerClient } from "../lib/docker.js";
import type { SandboxMount } from "../sandbox/types.js";
import { agentDnsServers, hasEmbeddedDns } from "./container-dns.js";

/** The file every resolver on Linux reads. Mounted read-only over Docker's. */
export const AGENT_RESOLV_CONF_TARGET = "/etc/resolv.conf";

/**
 * Where the seeded file lives **on the Docker host**, not in this container.
 * Under `/var/lib` because that is the conventional home for daemon-managed
 * state and it survives a restart of both the harness and the daemon.
 */
export const SEEDED_RESOLV_CONF_PATH = "/var/lib/blackhouse/agent-resolv.conf";

/**
 * The helper binds the file's *parent directory*, never the file.
 *
 * Docker creates a missing bind source, and it creates it as a directory. Bind
 * the file directly and a typo'd or not-yet-created path silently becomes a
 * directory at exactly the location we later mount over `/etc/resolv.conf`.
 * Binding the parent means the worst case is an empty directory beside it.
 */
const HELPER_BIND_DIR = "/bh-resolv";

/** Long enough for a container start on a loaded host, short enough to notice. */
const HELPER_TIMEOUT_MS = 20_000;

const LOG_PREFIX = "[blackhouse]";

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

/** Operator-supplied resolv.conf path on the Docker host, if set. */
export function resolvConfOverridePath(): string | null {
  const raw = process.env.BLACKHOUSE_AGENT_RESOLV_CONF?.trim();
  return raw ? raw : null;
}

/**
 * Render a minimal resolv.conf.
 *
 * Nameservers only — no `search` and no `domain`. Inheriting a search list we
 * cannot verify would append someone else's suffix to every lookup an agent
 * makes, and `options ndots` interacts with that badly enough that leaving both
 * out is the honest default.
 */
export function renderResolvConf(servers: string[]): string {
  const lines = [
    "# Generated by Blackhouse for agent containers.",
    "# Docker's embedded resolver (127.0.0.11) is unreachable from a gVisor",
    "# sandbox, so this file is bind-mounted over the container's own.",
    ...servers.map((s) => `nameserver ${s}`),
  ];
  return `${lines.join("\n")}\n`;
}

/** The mount that carries a host resolv.conf into an agent container. */
export function resolvConfMount(source: string): SandboxMount {
  return { source, target: AGENT_RESOLV_CONF_TARGET, readOnly: true };
}

/**
 * Does this runtime need the mount at all?
 *
 * Deliberately the inverse of {@link hasEmbeddedDns} rather than a second list
 * of runtime names: one place decides which runtimes can reach 127.0.0.11.
 */
export function needsResolvConfMount(runtime: string | null | undefined): boolean {
  return !hasEmbeddedDns(runtime);
}

// ---------------------------------------------------------------------------
// The helper container
// ---------------------------------------------------------------------------

/** One short-lived container run against the daemon's filesystem. */
export interface HelperRun {
  /** Image to run. The agent's own image — it is already pulled locally. */
  image: string;
  /** Host directory to bind at {@link HELPER_BIND_DIR}. */
  hostDir: string;
  /** Bind read-only. True whenever we are only looking. */
  readOnly: boolean;
  /** `/bin/sh -c` script. Takes its inputs from `env`, never by interpolation. */
  script: string;
  /** `KEY=value` pairs. */
  env: string[];
}

/** Injectable so the logic below is testable without a daemon. */
export type HelperRunner = (run: HelperRun) => Promise<number | null>;

/**
 * Run `sh -c` in a throwaway container with one host directory bound.
 *
 * `User: "0:0"` is not incidental: the agent images drop to an unprivileged
 * workspace user, and the bind source is created by the daemon as root, so the
 * image's default user cannot write into it. `NetworkMode: "none"` because a
 * container whose whole job is writing four lines to a file has no business on
 * a network — least of all this one, which is being fixed because agents can
 * reach the internet.
 */
async function runHelperContainer(run: HelperRun): Promise<number | null> {
  const docker = await getDockerClient();

  const container = await docker.createContainer({
    Image: run.image,
    // The agent images' ENTRYPOINT is the agent CLI itself. Override it, and
    // clear Cmd, or the image's CMD is appended as arguments to `sh -c`.
    Entrypoint: ["/bin/sh", "-c", run.script],
    Cmd: [],
    Env: run.env,
    User: "0:0",
    // Not labelled `blackhouse.managed`: that label means "an agent container"
    // to the reconciler and the admin container list, and this is neither.
    Labels: { "blackhouse.role": "resolv-seed" },
    HostConfig: {
      Binds: [`${run.hostDir}:${HELPER_BIND_DIR}${run.readOnly ? ":ro" : ""}`],
      NetworkMode: "none",
      Memory: 64 * 1024 * 1024,
      PidsLimit: 32,
      AutoRemove: false,
    },
  });

  try {
    await container.start();
    return await Promise.race([
      container
        .wait()
        .then((r) => (r as { StatusCode?: number })?.StatusCode ?? null)
        .catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), HELPER_TIMEOUT_MS)),
    ]);
  } finally {
    // Also the timeout path: a helper still running when we gave up is exactly
    // the one that must not be left behind.
    await container.remove({ force: true, v: false }).catch(() => {});
  }
}

/** Inputs reach the shell through the environment — never string-interpolated. */
function helperEnv(filePath: string, contents?: string): string[] {
  const env = [`BH_TARGET=${HELPER_BIND_DIR}/${path.posix.basename(filePath)}`];
  if (contents !== undefined) env.push(`BH_RESOLV=${contents}`);
  return env;
}

/** Does a non-empty file exist at this path on the Docker host? */
async function fileExistsOnHost(
  run: HelperRunner,
  image: string,
  filePath: string,
): Promise<boolean> {
  const code = await run({
    image,
    hostDir: path.posix.dirname(filePath),
    readOnly: true,
    script: 'test -s "$BH_TARGET"',
    env: helperEnv(filePath),
  }).catch(() => null);
  return code === 0;
}

/**
 * Write the file on the Docker host.
 *
 * Written to a sibling and renamed: a rename is atomic within the directory, so
 * a second agent starting concurrently either binds the old file or the new
 * one, never a half-written one. A running agent keeps the inode it was given,
 * so replacing the file never disturbs an agent already up.
 */
async function seedFileOnHost(
  run: HelperRunner,
  image: string,
  filePath: string,
  contents: string,
): Promise<boolean> {
  const code = await run({
    image,
    hostDir: path.posix.dirname(filePath),
    readOnly: false,
    script: 'set -e; printf "%s" "$BH_RESOLV" > "$BH_TARGET.tmp"; mv "$BH_TARGET.tmp" "$BH_TARGET"',
    env: helperEnv(filePath, contents),
  }).catch(() => null);
  return code === 0;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export interface ResolvConfPlan {
  /** The mount to add to the spec, or null when none could be established. */
  mount: SandboxMount | null;
  /** Set on every path that leaves the agent without a working resolver. */
  warning?: string;
}

/**
 * Established files, keyed by host path + contents.
 *
 * A helper container per agent start would be a container per start for no
 * gain — the file does not change between them. Failures are *not* cached: an
 * operator who creates the missing file expects the next start to pick it up
 * without restarting the harness.
 */
const established = new Map<string, Promise<boolean>>();

/** Drop the memoised seed/probe results (tests, and after a config change). */
export function resetResolvConfCache(): void {
  established.clear();
}

function once(key: string, work: () => Promise<boolean>): Promise<boolean> {
  const hit = established.get(key);
  if (hit) return hit;
  // Failures are forgotten, including thrown ones — a cached rejection would
  // both stick forever and surface as an unhandled rejection later.
  const started = work()
    .catch(() => false)
    .then((ok) => {
      if (!ok) established.delete(key);
      return ok;
    });
  established.set(key, started);
  return started;
}

/**
 * Decide what an agent's `/etc/resolv.conf` should be, and make it exist.
 *
 * Never throws: every failure returns `mount: null` plus a warning the caller
 * logs. An agent with no DNS can still be attached to, inspected, and fixed; an
 * agent that refused to start over its resolver cannot.
 */
export async function ensureAgentResolvConf(opts: {
  /** The runtime that will actually run — `resolution.effective`, not requested. */
  runtime: string | null | undefined;
  /** Image for the helper container. Pass the agent's own; it is already local. */
  image: string;
  /** Nameservers to seed. Defaults to {@link agentDnsServers}. */
  servers?: string[];
  /** Override path. Defaults to {@link resolvConfOverridePath}. */
  overridePath?: string | null;
  /** Injected in tests. */
  runHelper?: HelperRunner;
}): Promise<ResolvConfPlan> {
  if (!needsResolvConfMount(opts.runtime)) return { mount: null };

  const run = opts.runHelper ?? runHelperContainer;
  const override = opts.overridePath !== undefined ? opts.overridePath : resolvConfOverridePath();
  const degraded = (detail: string) =>
    `${LOG_PREFIX} runtime ${opts.runtime} cannot reach Docker's embedded resolver ` +
    `(127.0.0.11) and no usable ${AGENT_RESOLV_CONF_TARGET} could be provided: ${detail} ` +
    `The agent will start with NO general DNS — anything resolving a hostname ` +
    `(the agent CLI reaching its API, git clone, npm install) will fail. ` +
    `Fix: put a resolv.conf on the Docker host and set BLACKHOUSE_AGENT_RESOLV_CONF to it.`;

  if (override) {
    // A relative source is not a path to Docker — it is a *named volume*, which
    // would be created empty and mounted as a directory over resolv.conf.
    if (!path.posix.isAbsolute(override)) {
      return {
        mount: null,
        warning: degraded(
          `BLACKHOUSE_AGENT_RESOLV_CONF="${override}" is not an absolute path; ` +
            `Docker would read it as a named volume and mount a directory over the file.`,
        ),
      };
    }

    const ok = await once(`probe:${override}`, () =>
      fileExistsOnHost(run, opts.image, override),
    ).catch(() => false);

    if (ok) return { mount: resolvConfMount(override) };
    return {
      mount: null,
      warning: degraded(
        `BLACKHOUSE_AGENT_RESOLV_CONF="${override}" is missing or empty on the ` +
          `Docker host (the path is read by the daemon, not by this container).`,
      ),
    };
  }

  const servers = opts.servers ?? agentDnsServers();
  if (servers.length === 0) {
    return {
      mount: null,
      warning: degraded(`BLACKHOUSE_AGENT_DNS is empty, which opts out of supplying nameservers.`),
    };
  }

  const contents = renderResolvConf(servers);
  const ok = await once(`seed:${SEEDED_RESOLV_CONF_PATH}:${contents}`, () =>
    seedFileOnHost(run, opts.image, SEEDED_RESOLV_CONF_PATH, contents),
  ).catch(() => false);

  if (ok) return { mount: resolvConfMount(SEEDED_RESOLV_CONF_PATH) };
  return {
    mount: null,
    warning: degraded(
      `could not write ${SEEDED_RESOLV_CONF_PATH} on the Docker host via a helper ` +
        `container from image "${opts.image}".`,
    ),
  };
}
