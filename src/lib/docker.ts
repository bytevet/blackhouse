import Docker from "dockerode";
import { db } from "@/db";
import * as schema from "@/db/schema";

let dockerInstance: Docker | null = null;

async function createDockerClient(): Promise<Docker> {
  // Try loading config from database first
  try {
    const configs = await db
      .select()
      .from(schema.dockerConfigs)
      .limit(1);

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
  if (!dockerInstance) {
    dockerInstance = await createDockerClient();
  }
  return dockerInstance;
}

/** Reset the cached client so the next call re-reads config */
export function resetDockerClient(): void {
  dockerInstance = null;
}
