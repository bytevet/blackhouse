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
 * **Prefer `ssh -L 3100:127.0.0.1:3000 <host>` when you have shell access.**
 * Measured against this daemon the two are the same for one request — ~30ms
 * each, since the pool below removed the spawn cost — but SSH multiplexes
 * channels over a single session where this needs a pooled exec per TCP
 * connection. Under load that gap is not subtle: the same Playwright run took
 * 84s and flaked here, and 18.5s clean over SSH. This exists for environments
 * that have the Docker API and no shell, which is how it came to be written.
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

/**
 * Pre-spawned execs, waiting for a connection.
 *
 * Creating and starting a `docker exec` is a round trip to the daemon plus a
 * process spawn — about 90ms against this host, and it used to sit in front of
 * every single TCP connection. A browser opens several per page, so a page load
 * paid it several times over: measured at ~890ms for 22 requests when the
 * server itself answers in under a millisecond.
 *
 * So pay it in advance. The pool keeps a few streams already attached to a
 * waiting `nc`, hands one over the instant a connection arrives, and refills
 * behind it. The cost does not go away, it just stops being in the way.
 */
// Eight covers a browser's per-origin connection limit with room to spare.
// Raising it to 16 bought only ~40ms on a page load, and the pool is nearly
// free either way — 17 waiting `nc` processes measured at 4MB in the relay.
const POOL_SIZE = Number(process.env.TUNNEL_POOL ?? 8);

/**
 * How long a warmed stream may wait before it is thrown away.
 *
 * A pooled `nc` holds a real, open TCP connection to the server, and a server
 * will not hold one open forever with nothing on it — Node's HTTP server closes
 * an idle socket at `headersTimeout`, 60s by default, and answers 408. Handing
 * out a stream that has been sitting for longer than that turns the pool from
 * an optimisation into an intermittent failure, which is exactly what it did:
 * the first request after a quiet spell came back `408 Request Timeout`.
 *
 * Well under the timeout, so a stream is replaced long before the server gives
 * up on it.
 */
const MAX_IDLE_MS = 15_000;
const pool = [];
let filling = 0;

async function spawnExec() {
  const exec = await docker.getContainer(RELAY).exec({
    Cmd: ["nc", ...TARGET.split(" ")],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  return exec.start({ hijack: true, stdin: true });
}

function refill() {
  while (pool.length + filling < POOL_SIZE) {
    filling += 1;
    spawnExec()
      .then((stream) => {
        // A pooled stream that dies before it is used must not be handed out.
        stream.once("error", () => drop(stream));
        stream.once("end", () => drop(stream));
        pool.push({ stream, born: Date.now() });
      })
      .catch((err) => console.error("tunnel: prewarm failed —", err.message))
      .finally(() => {
        filling -= 1;
      });
  }
}

function drop(stream) {
  const i = pool.findIndex((e) => e.stream === stream);
  if (i >= 0) pool.splice(i, 1);
  stream.destroy?.();
}

/** Discard anything that has been waiting long enough to have gone stale. */
function evictStale() {
  const cutoff = Date.now() - MAX_IDLE_MS;
  for (const entry of [...pool]) if (entry.born < cutoff) drop(entry.stream);
  refill();
}

async function takeStream() {
  let entry;
  while ((entry = pool.shift())) {
    if (Date.now() - entry.born < MAX_IDLE_MS) break;
    entry.stream.destroy?.();
    entry = undefined;
  }
  refill();
  // An empty pool is a burst, not an error: fall back to spawning inline so a
  // connection is never refused, just slower.
  return entry ? entry.stream : await spawnExec();
}

const server = net.createServer(async (socket) => {
  socket.on("error", () => socket.destroy());
  try {
    const stream = await takeStream();

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

server.listen(LOCAL_PORT, "127.0.0.1", () => {
  refill();
  // Keep the pool fresh rather than only replacing on use: a tab left open
  // overnight should still find a live stream waiting for its next request.
  setInterval(evictStale, MAX_IDLE_MS / 2).unref();
  console.log(
    `tunnel: 127.0.0.1:${LOCAL_PORT} → ${RELAY}:[${TARGET}] on ${HOST} (pool ${POOL_SIZE})`,
  );
});
