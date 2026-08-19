/**
 * TCP → docker-exec tunnel.
 *
 * The app publishes 3000 on the VM's loopback only: it is an admin surface with
 * the Docker socket mounted, so binding 0.0.0.0 would hand the host to anyone
 * who portscans it. That leaves it unreachable from this machine — except that
 * we already hold mutual-TLS credentials for the Docker API, which can attach a
 * bidirectional stream to a process inside the network.
 *
 * So: listen locally, and for each connection run `nc app 3000` in a 4MB alpine
 * sidecar, splicing the two together. No new exposure, and the browser runs
 * here instead of on the VM.
 *
 * `Tty` must stay false. A TTY would translate line endings and corrupt every
 * HTTP body; the cost is Docker's 8-byte stream framing, which `demuxStream`
 * unpacks for us.
 */
import net from "node:net";
import { readFileSync } from "node:fs";
import Docker from "dockerode";

const HOST = process.env.TUNNEL_HOST ?? "docker-e2e.charset.dev";
const CERTS = process.env.DOCKER_CERT_PATH ?? `${process.env.HOME}/.docker-e2e`;
const LOCAL_PORT = Number(process.env.TUNNEL_PORT ?? 3100);
const TARGET = process.env.TUNNEL_TARGET ?? "app 3000";
const RELAY = process.env.TUNNEL_RELAY ?? "bh-relay";

const docker = new Docker({
  host: HOST,
  port: 443,
  protocol: "https",
  ca: readFileSync(`${CERTS}/ca.pem`),
  cert: readFileSync(`${CERTS}/cert.pem`),
  key: readFileSync(`${CERTS}/key.pem`),
});

const server = net.createServer(async (socket) => {
  socket.on("error", () => socket.destroy());
  try {
    const exec = await docker.getContainer(RELAY).exec({
      Cmd: ["nc", ...TARGET.split(" ")],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const stream = await exec.start({ hijack: true, stdin: true });

    // Container stdout → local socket. stderr is discarded: `nc` writes its
    // diagnostics there and they are not part of the payload.
    docker.modem.demuxStream(stream, socket, { write() {}, end() {} });
    socket.pipe(stream);

    const close = () => {
      socket.destroy();
      stream.destroy?.();
    };
    stream.on("end", close);
    stream.on("error", close);
    socket.on("close", close);
  } catch (err) {
    console.error("tunnel: exec failed —", err instanceof Error ? err.message : err);
    socket.destroy();
  }
});

server.listen(LOCAL_PORT, "127.0.0.1", () =>
  console.log(`tunnel: 127.0.0.1:${LOCAL_PORT} → ${RELAY}:[${TARGET}] on ${HOST}`),
);
