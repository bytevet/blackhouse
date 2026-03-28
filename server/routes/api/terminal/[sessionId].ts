import { defineWebSocketHandler } from "h3";
import { getDockerClient } from "../../../../src/lib/docker";
import { db } from "../../../../src/db";
import { codingSessions, session as authSession, user } from "../../../../src/db/schema";
import { eq, and } from "drizzle-orm";

interface TerminalState {
  stream: NodeJS.ReadWriteStream;
  exec: import("dockerode").Exec;
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
  // Look up the coding session
  const [codingSession] = await db
    .select()
    .from(codingSessions)
    .where(eq(codingSessions.id, sessionId))
    .limit(1);

  if (!codingSession || !codingSession.containerId) return null;
  if (codingSession.status !== "running") return null;

  // If a token (auth session token) is provided, validate ownership
  if (token) {
    const [authSess] = await db
      .select()
      .from(authSession)
      .where(eq(authSession.token, token))
      .limit(1);

    if (!authSess) return null;

    // Check ownership or admin
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
      // Reuse existing terminal session if stream is still alive
      const existing = activeTerminals.get(sessionId);
      let terminal: TerminalState;

      if (existing && !existing.stream.destroyed) {
        terminal = existing;
        // Remove old listeners (from previous WebSocket connection)
        existing.stream.removeAllListeners("data");
        existing.stream.removeAllListeners("end");
      } else {
        // Create new exec session (retry up to 3 times for containers still starting)
        const docker = await getDockerClient();
        const container = docker.getContainer(result.containerId);

        let lastErr: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const exec = await container.exec({
              Cmd: ["/bin/bash"],
              AttachStdin: true,
              AttachStdout: true,
              AttachStderr: true,
              Tty: true,
            });

            const stream = await exec.start({
              hijack: true,
              stdin: true,
              Tty: true,
            } as import("dockerode").ExecStartOptions);

            terminal = { stream, exec };
            activeTerminals.set(sessionId, terminal);
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            // Wait 2s before retry (container may still be starting)
            if (attempt < 2) {
              await new Promise((r) => setTimeout(r, 2000));
            }
          }
        }
        if (lastErr) throw lastErr;
      }

      // Pipe container output → WebSocket
      terminal.stream.on("data", (chunk: Buffer) => {
        try {
          peer.send(new Uint8Array(chunk));
        } catch {
          // peer may have disconnected
        }
      });

      terminal.stream.on("end", () => {
        activeTerminals.delete(sessionId);
        try {
          peer.close(1000, "Stream ended");
        } catch {
          // already closed
        }
      });
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
      // crossws Message object — try rawData first, then text()
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

    // Resize messages: binary frame with prefix byte 0x01, payload "cols:rows"
    if (raw.length > 1 && raw[0] === 0x01) {
      const payload = raw.subarray(1).toString("utf-8");
      const parts = payload.split(":");
      if (parts.length === 2) {
        const cols = parseInt(parts[0], 10);
        const rows = parseInt(parts[1], 10);
        if (cols > 0 && rows > 0) {
          try {
            await terminal.exec.resize({ w: cols, h: rows });
          } catch {
            // ignore resize errors
          }
          return;
        }
      }
    }

    // Write terminal input to the container's stdin
    terminal.stream.write(raw);
  },

  close(peer) {
    const url = new URL(peer.request?.url ?? "", "http://localhost");
    const sessionId = url.pathname.split("/").pop() ?? "";
    const terminal = activeTerminals.get(sessionId);

    if (terminal) {
      terminal.stream.end();
      activeTerminals.delete(sessionId);
    }
  },
});
