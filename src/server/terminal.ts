import { getDockerClient } from "@/lib/docker";
import type Dockerode from "dockerode";

interface TerminalSession {
  exec: Dockerode.Exec;
  stream: NodeJS.ReadWriteStream;
}

const activeSessions = new Map<string, TerminalSession>();

export async function createTerminalSession(
  containerId: string,
  sessionId: string,
): Promise<TerminalSession> {
  const existing = activeSessions.get(sessionId);
  if (existing) return existing;

  const docker = await getDockerClient();
  const container = docker.getContainer(containerId);

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
  });

  const termSession: TerminalSession = { exec, stream };
  activeSessions.set(sessionId, termSession);

  stream.on("end", () => {
    activeSessions.delete(sessionId);
  });

  return termSession;
}

export async function resizeTerminal(
  sessionId: string,
  cols: number,
  rows: number,
) {
  const session = activeSessions.get(sessionId);
  if (session) {
    await session.exec.resize({ h: rows, w: cols });
  }
}

export function cleanupTerminalSession(sessionId: string) {
  const session = activeSessions.get(sessionId);
  if (session) {
    session.stream.end();
    activeSessions.delete(sessionId);
  }
}
