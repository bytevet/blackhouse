#!/usr/bin/env node
/**
 * Forward a local TCP port to a remote host:port through an HTTP CONNECT proxy.
 *
 * Why this exists: some sandboxed environments permit outbound TCP only to 443,
 * but expose an HTTP CONNECT proxy that will tunnel to arbitrary ports. Neither
 * the Docker CLI nor dockerode routes `DOCKER_HOST=tcp://…` through such a
 * proxy, so a remote Docker daemon is unreachable without a shim. This is that
 * shim: it accepts locally, opens a CONNECT tunnel, and pipes bytes both ways.
 *
 * It is a byte pipe and nothing more — no TLS termination, no inspection. That
 * matters for Docker: the client's mutual-TLS handshake runs end to end against
 * the real daemon, so the daemon's certificate still authenticates it and the
 * client certificate still authorises us. The tunnel cannot read or alter the
 * session.
 *
 * The consequence to plan for: the client verifies the daemon's certificate
 * against whatever hostname is in DOCKER_HOST. Pointing it at 127.0.0.1 fails
 * verification against a cert issued for the VM's name. Map the real hostname
 * to loopback in /etc/hosts and keep using that name:
 *
 *   127.0.0.1  docker-e2e.example.net
 *   DOCKER_HOST=tcp://docker-e2e.example.net:2376
 *
 * Usage:
 *   node scripts/proxy-tunnel.mjs 2376:docker-e2e.example.net:2376 3000:docker-e2e.example.net:3000
 *
 * Each mapping is `localPort:remoteHost:remotePort`. The proxy is read from
 * HTTPS_PROXY / https_proxy / HTTP_PROXY / http_proxy.
 */

import net from "node:net";
import process from "node:process";

const PROXY_URL =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy;

if (!PROXY_URL) {
  console.error("No HTTPS_PROXY/HTTP_PROXY in the environment; nothing to tunnel through.");
  process.exit(1);
}

const proxy = new URL(PROXY_URL);
const PROXY_HOST = proxy.hostname;
const PROXY_PORT = Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80);
const PROXY_AUTH = proxy.username
  ? Buffer.from(
      `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
    ).toString("base64")
  : null;

/** Parse `localPort:remoteHost:remotePort`. */
function parseMapping(spec) {
  const match = /^(\d+):(.+):(\d+)$/.exec(spec);
  if (!match) throw new Error(`Bad mapping "${spec}" — expected localPort:remoteHost:remotePort`);
  return { localPort: Number(match[1]), remoteHost: match[2], remotePort: Number(match[3]) };
}

/**
 * Open a CONNECT tunnel and hand back the socket, positioned immediately after
 * the proxy's response headers.
 *
 * The proxy may deliver the start of the tunnelled stream in the same TCP
 * segment as its own `200` response. Anything after the header terminator is
 * therefore real payload and must be replayed to the client rather than
 * discarded — dropping it corrupts the very first frame of the session, which
 * for TLS means an unreadable handshake and a baffling error.
 */
function openTunnel(remoteHost, remotePort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PROXY_PORT, PROXY_HOST);
    let buffer = Buffer.alloc(0);

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) {
        // Refuse to buffer unboundedly if the peer is not speaking HTTP.
        if (buffer.length > 64 * 1024) {
          cleanup();
          socket.destroy();
          reject(new Error("Proxy sent no complete response header"));
        }
        return;
      }

      const header = buffer.subarray(0, end).toString("latin1");
      const leftover = buffer.subarray(end + 4);
      cleanup();

      const status = /^HTTP\/\d\.\d (\d{3})/.exec(header);
      if (!status || status[1] !== "200") {
        socket.destroy();
        reject(new Error(`Proxy refused CONNECT: ${header.split("\r\n")[0] || "(no status)"}`));
        return;
      }

      resolve({ socket, leftover });
    };

    const onError = (err) => {
      cleanup();
      reject(err);
    };

    function cleanup() {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
    }

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("connect", () => {
      const lines = [
        `CONNECT ${remoteHost}:${remotePort} HTTP/1.1`,
        `Host: ${remoteHost}:${remotePort}`,
        "Proxy-Connection: Keep-Alive",
      ];
      if (PROXY_AUTH) lines.push(`Proxy-Authorization: Basic ${PROXY_AUTH}`);
      socket.write(lines.join("\r\n") + "\r\n\r\n");
    });
  });
}

function listen({ localPort, remoteHost, remotePort }) {
  const server = net.createServer((client) => {
    client.on("error", () => client.destroy());

    openTunnel(remoteHost, remotePort).then(
      ({ socket, leftover }) => {
        if (client.destroyed) {
          socket.destroy();
          return;
        }
        // Replay anything the proxy bundled with its response header.
        if (leftover.length) client.write(leftover);

        socket.on("error", () => {
          socket.destroy();
          client.destroy();
        });
        client.pipe(socket);
        socket.pipe(client);
      },
      (err) => {
        console.error(`[tunnel] ${remoteHost}:${remotePort} — ${err.message}`);
        client.destroy();
      },
    );
  });

  server.on("error", (err) => {
    console.error(`[tunnel] cannot listen on ${localPort}: ${err.message}`);
    process.exitCode = 1;
  });

  // Bind to loopback only. This forwards to a Docker daemon; exposing it on all
  // interfaces would re-share that access with anything that can reach us.
  server.listen(localPort, "127.0.0.1", () => {
    console.log(`[tunnel] 127.0.0.1:${localPort} -> ${remoteHost}:${remotePort} via CONNECT`);
  });
  return server;
}

const specs = process.argv.slice(2);
if (specs.length === 0) {
  console.error("Usage: proxy-tunnel.mjs <localPort:remoteHost:remotePort> [...]");
  process.exit(1);
}

const servers = specs.map(parseMapping).map(listen);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const s of servers) s.close();
    process.exit(0);
  });
}
