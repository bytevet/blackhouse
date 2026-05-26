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

// Short-lived cache for container host-port lookups. Browser/IDE flows
// hit this multiple times per user gesture (every /browser/* REST call,
// every WS upgrade); each cache miss requires a `container.inspect()`
// round-trip to dockerode. Ports never change after a container starts,
// so a few seconds of staleness is safe — the cache is invalidated on
// session destroy via `resetDockerClient()` indirectly (callers see a
// throw from inspect on the next miss and tear down).
const HOST_PORT_TTL_MS = 5_000;
const hostPortCache = new Map<string, { port: number; expires: number }>();

/**
 * Resolve the ephemeral host port that Docker mapped to a given container's
 * internal port (e.g. 9223 for the browser service, 8443 for code-server).
 * Cached for {@link HOST_PORT_TTL_MS} since ports are immutable for the
 * lifetime of a container.
 */
export async function getContainerHostPort(
  sessionId: string,
  internalPort: number,
): Promise<number> {
  const cacheKey = `${sessionId}:${internalPort}`;
  const hit = hostPortCache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.port;

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

  const key = `${internalPort}/tcp`;
  const bindings = info.NetworkSettings?.Ports?.[key];
  if (!bindings || bindings.length === 0 || !bindings[0].HostPort) {
    throw new Error(`Session ${sessionId} container has no host binding for ${key}`);
  }
  const port = Number(bindings[0].HostPort);
  if (!Number.isFinite(port)) {
    throw new Error(`Session ${sessionId} returned non-numeric HostPort for ${key}`);
  }
  hostPortCache.set(cacheKey, { port, expires: Date.now() + HOST_PORT_TTL_MS });
  return port;
}

/** Drop any cached host-port lookups for a session. Call after destroy. */
export function invalidateContainerHostPortCache(sessionId: string): void {
  for (const k of hostPortCache.keys()) if (k.startsWith(`${sessionId}:`)) hostPortCache.delete(k);
}
