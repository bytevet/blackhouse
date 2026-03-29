import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/server/middleware";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { eq } from "drizzle-orm";
import { getDockerClient } from "@/lib/docker";

async function execInContainer(
  containerId: string,
  cmd: string[],
  { stdoutOnly = false }: { stdoutOnly?: boolean } = {},
): Promise<string> {
  const docker = await getDockerClient();
  const container = docker.getContainer(containerId);
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: !stdoutOnly,
  });
  const stream = await exec.start({ hijack: false, stdin: false });

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => {
      // Docker multiplexed stream: 8-byte header per frame
      // header[0]: 1=stdout, 2=stderr
      if (chunk.length > 8) {
        if (!stdoutOnly || chunk[0] === 1) {
          chunks.push(chunk.subarray(8));
        }
      }
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    stream.on("error", reject);
  });
}

async function requireSessionOwnership(
  sessionId: string,
  session: { user: { id: string; role?: string | null } },
) {
  const [codingSession] = await db
    .select()
    .from(schema.codingSessions)
    .where(eq(schema.codingSessions.id, sessionId))
    .limit(1);
  if (!codingSession) throw new Error("Session not found");
  if (codingSession.userId !== session.user.id && session.user.role !== "admin") {
    throw new Error("Forbidden");
  }
  return codingSession;
}

export const listFiles = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(z.object({ sessionId: z.string(), path: z.string() }))
  .handler(async ({ data, context }) => {
    const codingSession = await requireSessionOwnership(data.sessionId, context.session);
    const output = await execInContainer(codingSession.containerId!, [
      "ls",
      "-la",
      "--group-directories-first",
      data.path,
    ]);

    const lines = output.trim().split("\n").slice(1); // skip "total" line
    const files = [];

    // Also try to get git status for this directory
    // Use --stat without HEAD to avoid "Could not access 'HEAD'" in repos with no commits
    let gitStatusMap: Record<string, string> = {};
    try {
      const gitOutput = await execInContainer(
        codingSession.containerId!,
        ["git", "-C", data.path, "diff", "--stat"],
        { stdoutOnly: true },
      );
      for (const line of gitOutput.trim().split("\n")) {
        const match = line.match(/^\s*(.+?)\s+\|\s+(\d+)\s+([+-]+)/);
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
      const path = data.path.endsWith("/") ? `${data.path}${name}` : `${data.path}/${name}`;

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
  .middleware([authMiddleware])
  .inputValidator(z.object({ sessionId: z.string(), path: z.string() }))
  .handler(async ({ data, context }) => {
    const codingSession = await requireSessionOwnership(data.sessionId, context.session);
    const content = await execInContainer(codingSession.containerId!, ["cat", data.path]);
    return content;
  });

export const getGitStatus = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(z.object({ sessionId: z.string() }))
  .handler(async ({ data, context }) => {
    const codingSession = await requireSessionOwnership(data.sessionId, context.session);
    const output = await execInContainer(
      codingSession.containerId!,
      ["git", "-C", "/workspace", "diff", "--stat"],
      { stdoutOnly: true },
    );
    return output;
  });

export const getFileDiff = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(z.object({ sessionId: z.string(), path: z.string() }))
  .handler(async ({ data, context }) => {
    const codingSession = await requireSessionOwnership(data.sessionId, context.session);
    const output = await execInContainer(
      codingSession.containerId!,
      ["git", "diff", "--", data.path],
      { stdoutOnly: true },
    );
    return output || null;
  });
