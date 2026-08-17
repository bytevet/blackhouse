/**
 * Egress proxy + network lifecycle (dockerode).
 *
 * ## The topology, and why it is the enforcement
 *
 * Agents are attached to a Docker network created with `Internal: true`. Docker
 * gives such a network no default route and no NAT rule, so a container on it
 * cannot reach anything outside Docker no matter what it does — no `curl`, no
 * raw socket, no clever DNS trick. That is the enforcement. The allowlist is
 * only the policy applied at the one door left open.
 *
 * Three things sit on that internal network:
 *
 * - **the agents**, which have no other interface;
 * - **the proxy**, dual-homed onto the internal network *and* the ordinary
 *   `blackhouse` bridge, making it the only route out;
 * - **the harness itself**, connected here at runtime so it can still reach the
 *   agent's code-server (8443) and browser-service (9223) by container IP. The
 *   app is dual-homed for exactly the same reason the proxy is.
 *
 * ## Sharing
 *
 * One proxy and one network per *policy*, not per agent, keyed by
 * `sha1(canonical allowlist)`. Ten agents with the same allowlist share one
 * proxy container; change one agent's rules and it moves to a different key,
 * hence a different network, hence a proxy that will only ever apply the rules
 * it was keyed on. The credential check is what keeps that honest — an agent's
 * token only validates against the proxy holding its own policy.
 *
 * ## No CA, no TLS interception in v1
 *
 * See the header of `agent/egress-proxy/proxy.mjs`. A CONNECT-level domain
 * allowlist never terminates TLS, so there is nothing to sign. The hook, if
 * body-level auditing is ever wanted, is a generated leaf in the CONNECT
 * handler plus a CA mount here.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as tar from "tar-stream";
import type Docker from "dockerode";
import { getDockerClient } from "../lib/docker.js";

export const EGRESS_IMAGE = "blackhouse-egress:latest";
export const PROXY_PORT = 3128;

/**
 * DNS alias the proxy answers to on every internal network. Stable across
 * policy keys on purpose: the agent's `HTTPS_PROXY` reads the same either way,
 * and which proxy that name resolves to is decided by which network the agent
 * is on — i.e. by the topology, not by a string in the agent's environment.
 */
export const PROXY_ALIAS = "egress-proxy";

const NETWORK_PREFIX = "blackhouse-egress";
const MANAGED_LABEL = "blackhouse.managed";
const ROLE_LABEL = "blackhouse.role";
const POLICY_LABEL = "blackhouse.policy_key";

/** Docker object names allow `[a-zA-Z0-9][a-zA-Z0-9_.-]*`; keys are hex or a word. */
function shortKey(policyKey: string): string {
  const clean = policyKey.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
  return clean.length > 0 ? clean : "default";
}

export function egressNetworkName(policyKey: string): string {
  return `${NETWORK_PREFIX}-${shortKey(policyKey)}`;
}

export function proxyContainerName(policyKey: string): string {
  return `${NETWORK_PREFIX}-proxy-${shortKey(policyKey)}`;
}

/**
 * The proxy's credential for `GET /api/egress/policy`.
 *
 * Derived from `BETTER_AUTH_SECRET` rather than randomly generated, so it
 * survives a harness restart. A random per-process token would leave every
 * already-running proxy holding a credential the server no longer recognises,
 * and they would all silently fall back to their boot-time policy.
 */
export function proxyToken(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required to derive the egress proxy token");
  return createHash("sha256").update(`${secret}::blackhouse-egress-proxy`, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Pure: the environment an agent needs to use the proxy
// ---------------------------------------------------------------------------

/**
 * Build the proxy environment for one agent. Pure — no Docker, no DB — so the
 * exact strings are unit-testable without a daemon.
 *
 * Both cases of each variable are set. There is no standard here: curl and git
 * read the lowercase forms, most Node and Python tooling reads the uppercase,
 * and several read whichever they find first.
 *
 * `NO_PROXY` must contain the harness host. The sidecar posting events and the
 * skill scripts posting to channels are internal traffic that never leaves
 * Docker; routing them through the proxy would make the transcript itself
 * subject to the allowlist, so an agent with an empty allowlist would go
 * invisible instead of merely offline.
 */
export function proxyEnvForAgent(opts: {
  agentId: string;
  agentToken: string;
  proxyHost?: string;
  proxyPort?: number;
  noProxyHosts?: string[];
}): string[] {
  const host = opts.proxyHost ?? PROXY_ALIAS;
  const port = opts.proxyPort ?? PROXY_PORT;
  const cred = `${encodeURIComponent(opts.agentId)}:${encodeURIComponent(opts.agentToken)}`;
  const url = `http://${cred}@${host}:${port}`;

  const noProxy = [
    ...new Set(["localhost", "127.0.0.1", "::1", ...(opts.noProxyHosts ?? [])].filter(Boolean)),
  ].join(",");

  return [
    `HTTP_PROXY=${url}`,
    `http_proxy=${url}`,
    `HTTPS_PROXY=${url}`,
    `https_proxy=${url}`,
    `NO_PROXY=${noProxy}`,
    `no_proxy=${noProxy}`,
  ];
}

// ---------------------------------------------------------------------------
// Networks
// ---------------------------------------------------------------------------

async function findNetwork(docker: Docker, name: string): Promise<{ Id: string } | null> {
  const nets = await docker.listNetworks({ filters: JSON.stringify({ name: [name] }) });
  // The name filter is a substring match, so confirm the exact name.
  const hit = nets.find((n) => n.Name === name);
  return hit ? { Id: hit.Id } : null;
}

/**
 * Create (or find) the internal network for a policy.
 *
 * `Internal: true` is the entire security property of this module. Everything
 * else here is plumbing.
 */
export async function ensureEgressNetwork(policyKey: string): Promise<string> {
  const docker = await getDockerClient();
  const name = egressNetworkName(policyKey);

  const existing = await findNetwork(docker, name);
  if (existing) return name;

  try {
    await docker.createNetwork({
      Name: name,
      Driver: "bridge",
      Internal: true,
      CheckDuplicate: true,
      Labels: {
        [MANAGED_LABEL]: "true",
        [ROLE_LABEL]: "egress-network",
        [POLICY_LABEL]: policyKey,
      },
    });
  } catch (err) {
    // Another concurrent agent start may have won the race; that is a success.
    if (!(await findNetwork(docker, name))) throw err;
  }
  return name;
}

/** The harness's own container id, or null when it is not running in Docker. */
async function selfContainerId(docker: Docker): Promise<string | null> {
  const labelled = await docker.listContainers({
    filters: JSON.stringify({ label: [`${ROLE_LABEL}=app`] }),
  });
  if (labelled.length > 0) return labelled[0].Id;

  // Fallback: Docker sets the container hostname to its own short id unless
  // compose overrides it. Verified with an inspect so a host-mode hostname
  // that happens to look plausible cannot be mistaken for a container.
  const hostname = process.env.HOSTNAME;
  if (hostname) {
    try {
      const info = await docker.getContainer(hostname).inspect();
      return info.Id;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Attach the harness to a policy network, with the DNS alias agents use to
 * reach it.
 *
 * The alias matters: `BLACKHOUSE_CONTAINER_URL` is `http://app:3000` under
 * compose, and `app` is a compose-managed alias that exists only on the
 * compose network. On a network we created through the API we have to set it
 * ourselves, or every agent on an internal network loses the harness.
 */
export async function ensureAppOnNetwork(networkName: string, aliases: string[]): Promise<boolean> {
  const docker = await getDockerClient();
  const selfId = await selfContainerId(docker);
  if (!selfId) return false;

  const info = await docker.getContainer(selfId).inspect();
  if (info.NetworkSettings?.Networks?.[networkName]) return true;

  try {
    await docker.getNetwork(networkName).connect({
      Container: selfId,
      EndpointConfig: { Aliases: aliases.filter(Boolean) },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // "already exists in network" — a concurrent start beat us here.
    if (!/already exists|already connected/i.test(message)) throw err;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Image
// ---------------------------------------------------------------------------

function packBuildContext(): NodeJS.ReadableStream {
  const pack = tar.pack();
  const root = process.cwd();

  const dockerfile = fs.readFileSync(
    path.resolve(root, "agent/dockerfiles/egress-proxy.Dockerfile"),
    "utf-8",
  );
  pack.entry({ name: "Dockerfile" }, dockerfile);

  const dir = path.resolve(root, "agent/egress-proxy");
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const buf = fs.readFileSync(path.join(dir, entry.name));
    pack.entry({ name: `agent/egress-proxy/${entry.name}`, size: buf.length, mode: 0o644 }, buf);
  }

  pack.finalize();
  return pack as unknown as NodeJS.ReadableStream;
}

/** Build `blackhouse-egress:latest` if it is not already present. */
export async function ensureProxyImage(opts: { rebuild?: boolean } = {}): Promise<void> {
  const docker = await getDockerClient();

  if (!opts.rebuild) {
    try {
      await docker.getImage(EGRESS_IMAGE).inspect();
      return;
    } catch {
      // Not built yet — fall through.
    }
  }

  const stream = await docker.buildImage(packBuildContext(), { t: EGRESS_IMAGE });
  await new Promise<void>((resolve, reject) => {
    let lastError: string | null = null;
    stream.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json.error) lastError = String(json.error);
        } catch {
          // Non-JSON progress noise.
        }
      }
    });
    stream.on("end", () => (lastError ? reject(new Error(lastError)) : resolve()));
    stream.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Proxy container
// ---------------------------------------------------------------------------

async function findContainerByName(docker: Docker, name: string) {
  const list = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ name: [name] }),
  });
  // Docker's name filter is a substring regex; require the exact name.
  return list.find((c) => c.Names.some((n) => n === `/${name}`)) ?? null;
}

export interface EnsureProxyOptions {
  policyKey: string;
  /** Canonical allowlist, shipped as the boot-time fallback. */
  rules: string[];
  /** The internal network the agents on this policy live on. */
  internalNetwork: string;
  /** The ordinary bridge — the proxy's route out. */
  bridgeNetwork: string;
  /** Where the proxy fetches live policy from. */
  blackhouseUrl: string;
}

/**
 * Create/start the proxy for a policy and return the host:port agents use,
 * plus its IP on the internal network.
 *
 * The IP is returned because agents reach the proxy by its network alias, and
 * that alias is served by Docker's embedded DNS — which is unreachable under
 * gVisor (see `server/agents/container-dns.ts`). The caller pins the alias to
 * this IP in the agent's `/etc/hosts` so `HTTPS_PROXY` resolves under every
 * runtime.
 *
 * The proxy is created on the internal network and *then* connected to the
 * bridge, because Docker's container-create API accepts only one endpoint.
 * Order is deliberate: at no point does a half-configured proxy exist with a
 * route out but no internal interface to serve.
 */
export async function ensureProxyContainer(
  opts: EnsureProxyOptions,
): Promise<{ host: string; port: number; containerId: string; ip: string | null }> {
  const docker = await getDockerClient();
  const name = proxyContainerName(opts.policyKey);

  await ensureProxyImage();

  let existing = await findContainerByName(docker, name);

  if (existing && existing.State !== "running") {
    // A stopped proxy is restarted rather than recreated: its policy is
    // refetched at boot anyway, so there is nothing stale to clear out.
    await docker
      .getContainer(existing.Id)
      .start()
      .catch(() => {});
    existing = await findContainerByName(docker, name);
  }

  if (!existing) {
    const container = await docker.createContainer({
      name,
      Image: EGRESS_IMAGE,
      Env: [
        `EGRESS_POLICY_KEY=${opts.policyKey}`,
        `EGRESS_ALLOWLIST=${opts.rules.join(",")}`,
        `BLACKHOUSE_URL=${opts.blackhouseUrl}`,
        `EGRESS_PROXY_TOKEN=${proxyToken()}`,
        `EGRESS_PROXY_PORT=${PROXY_PORT}`,
      ],
      Labels: {
        [MANAGED_LABEL]: "true",
        [ROLE_LABEL]: "egress-proxy",
        [POLICY_LABEL]: opts.policyKey,
      },
      ExposedPorts: { [`${PROXY_PORT}/tcp`]: {} },
      NetworkingConfig: {
        EndpointsConfig: { [opts.internalNetwork]: { Aliases: [PROXY_ALIAS] } },
      },
      HostConfig: {
        // The proxy runs no model-authored code, but it is the one box with a
        // route out, so it gets the tightest configuration in the system.
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        ReadonlyRootfs: true,
        Tmpfs: { "/tmp": "rw,noexec,nosuid,size=16m" },
        Memory: 128 * 1024 * 1024,
        PidsLimit: 128,
        RestartPolicy: { Name: "unless-stopped" },
        // Never published to the host: agents reach it over the internal
        // network by DNS alias, and nothing else has any business talking to it.
        PortBindings: {},
      },
    });

    await docker
      .getNetwork(opts.bridgeNetwork)
      .connect({ Container: container.id })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!/already exists|already connected/i.test(message)) throw err;
      });

    await container.start();
    return {
      host: PROXY_ALIAS,
      port: PROXY_PORT,
      containerId: container.id,
      ip: await proxyIpOnNetwork(container.id, opts.internalNetwork),
    };
  }

  // Already running: make sure both legs are still attached. A proxy that lost
  // its bridge endpoint would deny nothing — it would fail *everything*, which
  // is at least loud.
  const info = await docker.getContainer(existing.Id).inspect();
  const attached = Object.keys(info.NetworkSettings?.Networks ?? {});
  for (const net of [opts.internalNetwork, opts.bridgeNetwork]) {
    if (attached.includes(net)) continue;
    await docker
      .getNetwork(net)
      .connect({
        Container: existing.Id,
        EndpointConfig: net === opts.internalNetwork ? { Aliases: [PROXY_ALIAS] } : {},
      })
      .catch(() => {});
  }

  return {
    host: PROXY_ALIAS,
    port: PROXY_PORT,
    containerId: existing.Id,
    ip: await proxyIpOnNetwork(existing.Id, opts.internalNetwork),
  };
}

/**
 * The proxy's address on the agents' network. Read after start rather than
 * assigned, because Docker allocates it; null if it cannot be read, in which
 * case the caller simply pins nothing and falls back to the embedded resolver.
 */
async function proxyIpOnNetwork(containerId: string, network: string): Promise<string | null> {
  try {
    const docker = await getDockerClient();
    const info = await docker.getContainer(containerId).inspect();
    return info.NetworkSettings?.Networks?.[network]?.IPAddress || null;
  } catch {
    return null;
  }
}

/**
 * Remove proxies whose policy no longer has any agents. Not called on the hot
 * path — a stale proxy is harmless (nothing can reach it once its network has
 * no agents on it), it just costs ~30MB of RSS until something reaps it.
 */
export async function pruneEgressProxies(activeKeys: readonly string[]): Promise<string[]> {
  const docker = await getDockerClient();
  const active = new Set(activeKeys);
  const removed: string[] = [];

  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [`${ROLE_LABEL}=egress-proxy`] }),
  });

  for (const c of containers) {
    const key = c.Labels?.[POLICY_LABEL];
    if (!key || active.has(key)) continue;
    await docker
      .getContainer(c.Id)
      .remove({ force: true })
      .catch(() => {});
    await docker
      .getNetwork(egressNetworkName(key))
      .remove()
      .catch(() => {
        // Still has endpoints (the harness itself is attached) — leave it.
      });
    removed.push(key);
  }
  return removed;
}
