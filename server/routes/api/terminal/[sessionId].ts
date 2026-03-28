import { defineWebSocketHandler } from "h3";
import { getDockerClient } from "../../../../src/lib/docker";
import { db } from "../../../../src/db";
import { codingSessions, session as authSession, user } from "../../../../src/db/schema";
import { eq } from "drizzle-orm";

const SCROLLBACK_LIMIT = 256 * 1024; // 256KB of recent output

interface TerminalState {
  stream: NodeJS.ReadWriteStream;
  containerId: string;
  scrollback: Buffer[];
  scrollbackSize: number;
  peers: Set<{ send: (data: Uint8Array | string) => void }>;
}

const activeTerminals = new Map<string, TerminalState>();

// Periodic cleanup of stale terminal sessions (every 5 minutes)
setInterval(
  () => {
    for (const [id, terminal] of activeTerminals) {
      try {
        if (terminal.stream.destroyed) {
          activeTerminals.delete(id);
        }
      } catch {
        activeTerminals.delete(id);
      }
    }
  },
  5 * 60 * 1000,
);

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

export default defineWebSocketHandler({
  async open(peer) {
    const url = new URL(peer.request?.url ?? "", "http://localhost");
    const sessionId = url.pathname.split("/").pop() ?? "";
    const token = url.searchParams.get("token") ?? undefined;

    const result = await validateSession(sessionId, token);
    if (!result) {
      peer.send("[Auth failed or session not running]");
      peer.close(4001, "Unauthorized");
      return;
    }

    try {
      // Reuse existing attach stream if still alive
      const existing = activeTerminals.get(sessionId);
      let terminal: TerminalState;

      if (existing && !existing.stream.destroyed) {
        terminal = existing;

        // Replay cached scrollback so the new peer sees previous output
        for (const chunk of existing.scrollback) {
          try {
            const tagged = Buffer.allocUnsafe(1 + chunk.length);
            tagged[0] = 0x00;
            chunk.copy(tagged, 1);
            peer.send(new Uint8Array(tagged));
          } catch {
            break;
          }
        }
      } else {
        // Attach to the container's main process
        const docker = await getDockerClient();
        const container = docker.getContainer(result.containerId);

        let stream: NodeJS.ReadWriteStream | null = null;
        let lastErr: unknown;

        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            stream = (await container.attach({
              stream: true,
              stdin: true,
              stdout: true,
              stderr: true,
            })) as NodeJS.ReadWriteStream;
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            if (attempt < 2) {
              await new Promise((r) => setTimeout(r, 2000));
            }
          }
        }
        if (lastErr || !stream) throw lastErr || new Error("Failed to attach");

        terminal = {
          stream,
          containerId: result.containerId,
          scrollback: [],
          scrollbackSize: 0,
          peers: new Set(),
        };
        activeTerminals.set(sessionId, terminal);

        // Set up stream listeners ONCE (shared across all peers)
        terminal.stream.on("data", (chunk: Buffer) => {
          // Cache in scrollback ring buffer
          terminal.scrollback.push(Buffer.from(chunk));
          terminal.scrollbackSize += chunk.length;
          while (terminal.scrollbackSize > SCROLLBACK_LIMIT && terminal.scrollback.length > 1) {
            const removed = terminal.scrollback.shift()!;
            terminal.scrollbackSize -= removed.length;
          }

          // Broadcast to ALL connected peers
          const tagged = Buffer.allocUnsafe(1 + chunk.length);
          tagged[0] = 0x00;
          chunk.copy(tagged, 1);
          const data = new Uint8Array(tagged);
          for (const p of terminal.peers) {
            try {
              p.send(data);
            } catch {
              // peer may have disconnected
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
      terminal.peers.add(peer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to attach to container";
      peer.send(`[Error: ${msg}]`);
      peer.close(4002, msg);
    }
  },

  async message(peer, message) {
    const url = new URL(peer.request?.url ?? "", "http://localhost");
    const sessionId = url.pathname.split("/").pop() ?? "";
    const terminal = activeTerminals.get(sessionId);

    if (!terminal) return;

    // Convert message to raw bytes
    let raw: Buffer;
    if (Buffer.isBuffer(message)) {
      raw = message;
    } else if (typeof message === "string") {
      raw = Buffer.from(message, "utf-8");
    } else if (message instanceof ArrayBuffer || message instanceof Uint8Array) {
      raw = Buffer.from(message);
    } else if (message && typeof message === "object") {
      const msg = message as { rawData?: ArrayBuffer | Uint8Array; text?: () => string };
      if (msg.rawData) {
        raw = Buffer.from(msg.rawData);
      } else if (msg.text) {
        raw = Buffer.from(msg.text(), "utf-8");
      } else {
        raw = Buffer.from(String(message), "utf-8");
      }
    } else {
      raw = Buffer.from(String(message), "utf-8");
    }

    if (raw.length === 0) return;

    const type = raw[0];
    const payload = raw.subarray(1);

    switch (type) {
      case 0x00: {
        // Terminal input → write to container stdin
        terminal.stream.write(payload);
        break;
      }
      case 0x01: {
        // Resize command → payload is "cols:rows"
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
        // Unknown type — write raw to stdin as fallback for plain text clients
        terminal.stream.write(raw);
        break;
    }
  },

  close(peer) {
    // Remove this peer from the set — stream stays alive for other peers / reconnection
    const url = new URL(peer.request?.url ?? "", "http://localhost");
    const sessionId = url.pathname.split("/").pop() ?? "";
    const terminal = activeTerminals.get(sessionId);

    if (terminal) {
      terminal.peers.delete(peer);
    }
  },
});
