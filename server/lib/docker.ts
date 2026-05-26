import Docker from "dockerode";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";

let dockerInstance: Docker | null = null;
let dockerPromise: Promise<Docker> | null = null;

async function createDockerClient(): Promise<Docker> {
  // Try loading config from database first
  try {
    const configs = await db.select().from(schema.dockerConfigs).limit(1);

    if (configs.length > 0) {
      const config = configs[0];

      if (config.host) {
        const opts: Docker.DockerOptions = {
          host: config.host,
          port: config.port ?? undefined,
        };

        if (config.tlsCa && config.tlsCert && config.tlsKey) {
          opts.ca = config.tlsCa;
          opts.cert = config.tlsCert;
          opts.key = config.tlsKey;
        }

        return new Docker(opts);
      }

      if (config.socketPath) {
        return new Docker({ socketPath: config.socketPath });
      }
    }
  } catch {
    // Database may not be available yet; fall through to defaults
  }

  // Fall back to environment variables
  if (process.env.DOCKER_HOST) {
    const url = new URL(process.env.DOCKER_HOST);
    const opts: Docker.DockerOptions = {
      host: url.hostname,
      port: Number(url.port) || undefined,
    };

    if (process.env.DOCKER_TLS_VERIFY === "1") {
      const certPath = process.env.DOCKER_CERT_PATH ?? "";
      const fs = await import("fs");
      const path = await import("path");
      opts.ca = fs.readFileSync(path.join(certPath, "ca.pem"), "utf-8");
      opts.cert = fs.readFileSync(path.join(certPath, "cert.pem"), "utf-8");
      opts.key = fs.readFileSync(path.join(certPath, "key.pem"), "utf-8");
    }

    return new Docker(opts);
  }

  // Default: local socket
  return new Docker({ socketPath: "/var/run/docker.sock" });
}

export async function getDockerClient(): Promise<Docker> {
  if (dockerInstance) return dockerInstance;
  if (!dockerPromise) {
    dockerPromise = createDockerClient().then((client) => {
      dockerInstance = client;
      dockerPromise = null;
      return client;
    });
  }
  return dockerPromise;
}

/** Reset the cached client so the next call re-reads config */
export function resetDockerClient(): void {
  dockerInstance = null;
  dockerPromise = null;
}

// Short-lived cache for container endpoint lookups. Browser/IDE flows
// hit this multiple times per user gesture (every /browser/* REST call,
// every WS upgrade); each cache miss requires a `container.inspect()`
// round-trip to dockerode. The endpoint never changes after a container
// starts, so a few seconds of staleness is safe — the cache is invalidated
// on session destroy via `invalidateContainerEndpointCache(sessionId)`.
const ENDPOINT_TTL_MS = 5_000;
const endpointCache = new Map<string, { endpoint: ContainerEndpoint; expires: number }>();

export interface ContainerEndpoint {
  host: string;
  port: number;
}

/**
 * Resolve where to reach an in-agent-container service (e.g. 9223 for the
 * browser service, 8443 for code-server). Cached for {@link ENDPOINT_TTL_MS}
 * since the endpoint is immutable for the lifetime of a container.
 *
 * Two reachability modes:
 *
 * 1. **Container-network mode** (`BLACKHOUSE_NETWORK` env var set, used by
 *    `compose.yml`): Blackhouse runs inside its own container, so the host's
 *    loopback is NOT reachable as `127.0.0.1` from here. We attach every
 *    agent container to the same Docker network as the Blackhouse server
 *    (see `server/api/sessions.ts` createContainer), then reach it by the
 *    agent's IP on that network + its INTERNAL port. No host port mapping
 *    needed; the request never leaves Docker.
 *
 * 2. **Host mode** (default — local dev: `npm run dev` on the host):
 *    `127.0.0.1` IS the host's loopback, so we reach the agent via the
 *    ephemeral host port Docker mapped to its internal port (per the
 *    `PortBindings` block in createContainer).
 */
export async function getContainerEndpoint(
  sessionId: string,
  internalPort: number,
): Promise<ContainerEndpoint> {
  const cacheKey = `${sessionId}:${internalPort}`;
  const hit = endpointCache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.endpoint;

  const [codingSession] = await db
    .select({ containerId: schema.codingSessions.containerId })
    .from(schema.codingSessions)
    .where(eq(schema.codingSessions.id, sessionId))
    .limit(1);

  if (!codingSession || !codingSession.containerId) {
    throw new Error(`Session ${sessionId} has no running container`);
  }

  const docker = await getDockerClient();
  const container = docker.getContainer(codingSession.containerId);
  const info = await container.inspect();

  const networkName = process.env.BLACKHOUSE_NETWORK;
  let endpoint: ContainerEndpoint;

  if (networkName) {
    const ip = info.NetworkSettings?.Networks?.[networkName]?.IPAddress;
    if (!ip) {
      throw new Error(
        `Session ${sessionId} container is not attached to network "${networkName}" ` +
          `(BLACKHOUSE_NETWORK is set). NetworkSettings.Networks keys: ` +
          `${Object.keys(info.NetworkSettings?.Networks ?? {}).join(", ") || "<none>"}`,
      );
    }
    endpoint = { host: ip, port: internalPort };
  } else {
    const key = `${internalPort}/tcp`;
    const bindings = info.NetworkSettings?.Ports?.[key];
    if (!bindings || bindings.length === 0 || !bindings[0].HostPort) {
      throw new Error(`Session ${sessionId} container has no host binding for ${key}`);
    }
    const port = Number(bindings[0].HostPort);
    if (!Number.isFinite(port)) {
      throw new Error(`Session ${sessionId} returned non-numeric HostPort for ${key}`);
    }
    endpoint = { host: "127.0.0.1", port };
  }

  endpointCache.set(cacheKey, { endpoint, expires: Date.now() + ENDPOINT_TTL_MS });
  return endpoint;
}

/** Drop any cached endpoint lookups for a session. Call after destroy. */
export function invalidateContainerEndpointCache(sessionId: string): void {
  for (const k of endpointCache.keys()) if (k.startsWith(`${sessionId}:`)) endpointCache.delete(k);
}
