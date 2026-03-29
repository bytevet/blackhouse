// @ts-nocheck — Hono WebSocket types not fully resolved
import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import type { createNodeWebSocket } from "@hono/node-ws";
import { getDockerClient } from "../lib/docker.js";
import { db } from "../db/index.js";
import { codingSessions, session as authSession, user } from "../db/schema.js";
import { eq } from "drizzle-orm";

const SCROLLBACK_LIMIT = 256 * 1024; // 256KB of recent output

interface TerminalState {
  stream: NodeJS.ReadWriteStream & { destroyed?: boolean };
  containerId: string;
  scrollback: Buffer[];
  scrollbackSize: number;
  errored: boolean;
  peers: Set<WSContext>;
}

const activeTerminals = new Map<string, TerminalState>();

// Periodic cleanup of stale terminal sessions (every 5 minutes)
setInterval(
  () => {
    for (const [id, terminal] of activeTerminals) {
      try {
        if (terminal.stream.destroyed || terminal.errored) {
          activeTerminals.delete(id);
        }
      } catch {
        activeTerminals.delete(id);
      }
    }
  },
  5 * 60 * 1000,
);

function tagOutput(chunk: Buffer): Uint8Array {
  const tagged = Buffer.allocUnsafe(1 + chunk.length);
  tagged[0] = 0x00;
  chunk.copy(tagged, 1);
  return new Uint8Array(tagged);
}

async function validateSession(
  sessionId: string,
  token?: string,
): Promise<{ containerId: string } | null> {
  const [codingSession] = await db
    .select()
    .from(codingSessions)
    .where(eq(codingSessions.id, sessionId))
    .limit(1);

  if (!codingSession || !codingSession.containerId) return null;
  if (codingSession.status !== "running") return null;

  if (token) {
    const [authSess] = await db
      .select()
      .from(authSession)
      .where(eq(authSession.token, token))
      .limit(1);

    if (!authSess) return null;

    if (codingSession.userId !== authSess.userId) {
      const [usr] = await db.select().from(user).where(eq(user.id, authSess.userId)).limit(1);
      if (!usr || usr.role !== "admin") return null;
    }
  }

  return { containerId: codingSession.containerId };
}

const DOCKER_ATTACH_KEYS = new Set(["stream", "stdin", "stdout", "stderr", "hijack", "Tty"]);

/**
 * Strip the dockerode attach metadata that can leak as the first data chunk.
 */
function stripAttachMetadata(buf: Buffer): Buffer {
  if (buf.length === 0 || buf[0] !== 0x7b /* '{' */) return buf;

  const scanLimit = Math.min(buf.length, 256);

  let depth = 0;
  let jsonEnd = -1;
  for (let i = 0; i < scanLimit; i++) {
    const b = buf[i];
    if (b > 0x7e || (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d)) return buf;
    if (b === 0x7b) depth++;
    else if (b === 0x7d) {
      depth--;
      if (depth === 0) {
        jsonEnd = i + 1;
        break;
      }
    }
  }
  if (jsonEnd === -1) return buf;

  try {
    const obj = JSON.parse(buf.subarray(0, jsonEnd).toString("utf-8"));
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return buf;

    const keys = Object.keys(obj);
    if (keys.length === 0) return buf;
    if (!keys.every((k) => DOCKER_ATTACH_KEYS.has(k))) return buf;

    const remaining = buf.subarray(jsonEnd);
    return remaining.length > 0 ? remaining : Buffer.alloc(0);
  } catch {
    return buf;
  }
}

/**
 * Strip Docker log multiplexing headers if present.
 */
function stripDockerLogHeaders(buf: Buffer): Buffer {
  if (
    buf.length >= 8 &&
    (buf[0] === 1 || buf[0] === 2) &&
    buf[1] === 0 &&
    buf[2] === 0 &&
    buf[3] === 0
  ) {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset + 8 <= buf.length) {
      const size = buf.readUInt32BE(offset + 4);
      if (offset + 8 + size > buf.length) break;
      chunks.push(buf.subarray(offset + 8, offset + 8 + size));
      offset += 8 + size;
    }
    if (offset < buf.length) {
      chunks.push(buf.subarray(offset));
    }
    return Buffer.concat(chunks);
  }
  return buf;
}

/**
 * Create the terminal WebSocket route.
 * Requires the upgradeWebSocket helper from @hono/node-ws.
 */
export function createTerminalRoute(
  upgradeWebSocket: ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"],
) {
  const app = new Hono();

  app.get(
    "/:sessionId",
    upgradeWebSocket((c) => {
      const sessionId = c.req.param("sessionId");
      const token = c.req.query("token");

      return {
        async onOpen(_evt, ws) {
          const result = await validateSession(sessionId, token ?? undefined);
          if (!result) {
            ws.send("[Auth failed or session not running]");
            ws.close(4001, "Unauthorized");
            return;
          }

          try {
            const existing = activeTerminals.get(sessionId);
            let terminal: TerminalState;

            if (existing && !existing.stream.destroyed && !existing.errored) {
              terminal = existing;

              // Replay cached scrollback so the new peer sees previous output
              for (const chunk of existing.scrollback) {
                try {
                  ws.send(tagOutput(chunk));
                } catch {
                  break;
                }
              }
            } else {
              const docker = await getDockerClient();
              const container = docker.getContainer(result.containerId);

              // Fetch recent container logs
              let initialLogs: Buffer | null = null;
              try {
                const logStream = await container.logs({
                  stdout: true,
                  stderr: true,
                  tail: 200,
                });
                if (Buffer.isBuffer(logStream)) {
                  initialLogs = logStream;
                } else if (typeof logStream === "string") {
                  initialLogs = Buffer.from(logStream, "utf-8");
                }
              } catch {
                // ignore log fetch errors
              }

              // Attach to the container's main process
              let stream: NodeJS.ReadWriteStream | null = null;
              let lastErr: unknown;

              for (let attempt = 0; attempt < 3; attempt++) {
                try {
                  stream = (await container.attach({
                    stream: true,
                    stdin: true,
                    stdout: true,
                    stderr: true,
                    hijack: true,
                  })) as unknown as NodeJS.ReadWriteStream;
                  lastErr = null;
                  break;
                } catch (err) {
                  lastErr = err;
                  if (attempt < 2) {
                    await new Promise((r) => setTimeout(r, 2000));
                  }
                }
              }
              if (lastErr || !stream) throw lastErr || new Error("Failed to attach to terminal");

              terminal = {
                stream,
                containerId: result.containerId,
                scrollback: [],
                scrollbackSize: 0,
                errored: false,
                peers: new Set(),
              };
              activeTerminals.set(sessionId, terminal);

              terminal.stream.on("error", () => {
                terminal.errored = true;
              });

              // Send initial logs to scrollback
              if (initialLogs && initialLogs.length > 0) {
                const cleaned = stripDockerLogHeaders(initialLogs);
                if (cleaned.length > 0) {
                  terminal.scrollback.push(cleaned);
                  terminal.scrollbackSize += cleaned.length;
                }
              }

              // Replay scrollback to this first peer
              for (const chunk of terminal.scrollback) {
                try {
                  ws.send(tagOutput(chunk));
                } catch {
                  break;
                }
              }

              // Set up stream listeners ONCE (shared across all peers)
              let isFirstChunk = true;
              terminal.stream.on("data", (rawChunk: Buffer) => {
                let chunk: Buffer = Buffer.from(rawChunk) as Buffer;

                if (isFirstChunk) {
                  isFirstChunk = false;
                  chunk = stripAttachMetadata(chunk);
                  if (chunk.length === 0) return;
                }

                // Cache in scrollback ring buffer
                terminal.scrollback.push(chunk);
                terminal.scrollbackSize += chunk.length;
                while (
                  terminal.scrollbackSize > SCROLLBACK_LIMIT &&
                  terminal.scrollback.length > 1
                ) {
                  const removed = terminal.scrollback.shift()!;
                  terminal.scrollbackSize -= removed.length;
                }

                // Broadcast to ALL connected peers
                const data = tagOutput(chunk);
                for (const p of terminal.peers) {
                  try {
                    p.send(data);
                  } catch {
                    terminal.peers.delete(p);
                  }
                }
              });

              terminal.stream.on("end", async () => {
                activeTerminals.delete(sessionId);

                try {
                  await db
                    .update(codingSessions)
                    .set({ status: "stopped", updatedAt: new Date() })
                    .where(eq(codingSessions.id, sessionId));
                } catch {
                  // ignore
                }

                for (const p of terminal.peers) {
                  try {
                    p.close(1000, "Stream ended");
                  } catch {
                    // already closed
                  }
                }
                terminal.peers.clear();
              });
            }

            // Add this peer to the set
            terminal.peers.add(ws);
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Failed to create terminal";
            ws.send(`[Error: ${msg}]`);
            ws.close(4002, msg);
          }
        },

        async onMessage(evt, ws) {
          const terminal = activeTerminals.get(sessionId);
          if (!terminal) return;

          // Convert message to raw bytes
          let raw: Buffer;
          const message = evt.data;
          if (Buffer.isBuffer(message)) {
            raw = message;
          } else if (typeof message === "string") {
            raw = Buffer.from(message, "utf-8");
          } else if (message instanceof ArrayBuffer || message instanceof Uint8Array) {
            raw = Buffer.from(message);
          } else {
            raw = Buffer.from(String(message), "utf-8");
          }

          if (raw.length === 0) return;

          const type = raw[0];
          const payload = raw.subarray(1);

          switch (type) {
            case 0x00: {
              // Terminal input -> write to container stdin
              terminal.stream.write(payload);
              break;
            }
            case 0x01: {
              // Resize command -> payload is "cols:rows"
              const parts = payload.toString("utf-8").split(":");
              if (parts.length === 2) {
                const cols = parseInt(parts[0], 10);
                const rows = parseInt(parts[1], 10);
                if (cols > 0 && rows > 0) {
                  try {
                    const docker = await getDockerClient();
                    const container = docker.getContainer(terminal.containerId);
                    await container.resize({ h: rows, w: cols });
                  } catch {
                    // ignore resize errors
                  }
                }
              }
              break;
            }
            default:
              // Unknown type prefix - drop silently
              break;
          }
        },

        onClose(_evt, ws) {
          const terminal = activeTerminals.get(sessionId);
          if (terminal) {
            terminal.peers.delete(ws);
          }
        },
      };
    }),
  );

  return app;
}
