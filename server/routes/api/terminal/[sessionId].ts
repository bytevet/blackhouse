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
        // Create new exec session
        const docker = await getDockerClient();
        const container = docker.getContainer(result.containerId);

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
      }

      // Pipe container output → WebSocket
      terminal.stream.on("data", (chunk: Buffer) => {
        try {
          peer.send(chunk.toString("binary"));
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

    const text = typeof message === "string" ? message : message.text();

    // Check if it's a resize message
    try {
      const parsed = JSON.parse(text);
      if (parsed.type === "resize" && parsed.cols && parsed.rows) {
        await terminal.exec.resize({
          w: parsed.cols,
          h: parsed.rows,
        });
        return;
      }
    } catch {
      // Not JSON, treat as terminal input
    }

    // Write raw input to the container's stdin
    terminal.stream.write(text);
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
