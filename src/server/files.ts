import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { codingSessions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getDockerClient } from "@/lib/docker";

async function getAuthorizedSession(sessionId: string) {
  const request = getRequest();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new Error("Unauthorized");

  const [codingSession] = await db
    .select()
    .from(codingSessions)
    .where(eq(codingSessions.id, sessionId))
    .limit(1);

  if (!codingSession) throw new Error("Session not found");
  if (
    codingSession.userId !== session.user.id &&
    session.user.role !== "admin"
  ) {
    throw new Error("Forbidden");
  }
  if (!codingSession.containerId) throw new Error("No container");

  return codingSession;
}

async function execInContainer(
  containerId: string,
  cmd: string[],
): Promise<string> {
  const docker = await getDockerClient();
  const container = docker.getContainer(containerId);
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: false, stdin: false });

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => {
      // Docker multiplexed stream: first 8 bytes are header
      if (chunk.length > 8) {
        chunks.push(chunk.subarray(8));
      }
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    stream.on("error", reject);
  });
}

export const listFiles = createServerFn({ method: "GET" })
  .inputValidator((input: { sessionId: string; path: string }) => input)
  .handler(async ({ data }) => {
    const session = await getAuthorizedSession(data.sessionId);
    const output = await execInContainer(session.containerId!, [
      "ls",
      "-la",
      "--group-directories-first",
      data.path,
    ]);

    const lines = output.trim().split("\n").slice(1); // skip "total" line
    const files = [];

    // Also try to get git status for this directory
    let gitStatusMap: Record<string, string> = {};
    try {
      const gitOutput = await execInContainer(session.containerId!, [
        "git",
        "-C",
        data.path,
        "diff",
        "--stat",
        "HEAD",
      ]);
      for (const line of gitOutput.trim().split("\n")) {
        const match = line.match(
          /^\s*(.+?)\s+\|\s+(\d+)\s+([+-]+)/,
        );
        if (match) {
          const plusCount = (match[3].match(/\+/g) ?? []).length;
          const minusCount = (match[3].match(/-/g) ?? []).length;
          gitStatusMap[match[1].trim()] = `+${plusCount} -${minusCount}`;
        }
      }
    } catch {
      // not a git repo or no changes
    }

    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 9) continue;
      const name = parts.slice(8).join(" ");
      if (name === "." || name === "..") continue;

      const isDirectory = line.startsWith("d");
      const path = data.path.endsWith("/")
        ? `${data.path}${name}`
        : `${data.path}/${name}`;

      files.push({
        name,
        path,
        isDirectory,
        gitStatus: gitStatusMap[name],
      });
    }

    return files;
  });

export const readFile = createServerFn({ method: "GET" })
  .inputValidator((input: { sessionId: string; path: string }) => input)
  .handler(async ({ data }) => {
    const session = await getAuthorizedSession(data.sessionId);
    const content = await execInContainer(session.containerId!, [
      "cat",
      data.path,
    ]);
    return content;
  });

export const getGitStatus = createServerFn({ method: "GET" })
  .inputValidator((input: { sessionId: string }) => input)
  .handler(async ({ data }) => {
    const session = await getAuthorizedSession(data.sessionId);
    const output = await execInContainer(session.containerId!, [
      "git",
      "-C",
      "/workspace",
      "diff",
      "--stat",
    ]);
    return output;
  });

export const getFileDiff = createServerFn({ method: "GET" })
  .inputValidator((input: { sessionId: string; path: string }) => input)
  .handler(async ({ data }) => {
    const session = await getAuthorizedSession(data.sessionId);
    const output = await execInContainer(session.containerId!, [
      "git",
      "diff",
      "HEAD",
      "--",
      data.path,
    ]);
    return output || null;
  });
