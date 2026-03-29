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
  if (!codingSession.containerId) throw new Error("Session has no container");
  if (codingSession.userId !== session.user.id && session.user.role !== "admin") {
    throw new Error("Forbidden");
  }
  return codingSession as typeof codingSession & { containerId: string };
}

export const listFiles = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      sessionId: z.string(),
      path: z.string().refine((p) => !p.includes(".."), "Path traversal not allowed"),
    }),
  )
  .handler(async ({ data, context }) => {
    const codingSession = await requireSessionOwnership(data.sessionId, context.session);
    const output = await execInContainer(codingSession.containerId, [
      "ls",
      "-la",
      "--group-directories-first",
      data.path,
    ]);

    const lines = output.trim().split("\n").slice(1); // skip "total" line
    const files = [];

    // Get git status and build a map of path → status code
    let gitStatusMap: Record<string, string> = {};
    try {
      const gitRoot = (
        await execInContainer(
          codingSession.containerId,
          ["git", "-C", data.path, "rev-parse", "--show-toplevel"],
          { stdoutOnly: true },
        )
      ).trim();
      const gitOutput = await execInContainer(
        codingSession.containerId,
        ["git", "-C", gitRoot, "status", "--porcelain"],
        { stdoutOnly: true },
      );
      gitStatusMap = parseGitPorcelain(gitOutput, gitRoot, data.path);
    } catch {
      // not a git repo
    }

    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 9) continue;
      const name = parts.slice(8).join(" ");
      if (name === "." || name === "..") continue;

      const isDirectory = line.startsWith("d");
      const absPath = data.path.endsWith("/") ? `${data.path}${name}` : `${data.path}/${name}`;

      // Look up by absolute path first, then by name
      const status = gitStatusMap[absPath] || gitStatusMap[name];
      let gitStatus: string | undefined;
      if (status) {
        if (status === "??" || status === "A") gitStatus = "U";
        else if (status === "D") gitStatus = "D";
        else gitStatus = "M";
      }

      files.push({
        name,
        path: absPath,
        isDirectory,
        gitStatus,
      });
    }

    return files;
  });

export const readFile = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      sessionId: z.string(),
      path: z.string().refine((p) => !p.includes(".."), "Path traversal not allowed"),
    }),
  )
  .handler(async ({ data, context }) => {
    const codingSession = await requireSessionOwnership(data.sessionId, context.session);
    const content = await execInContainer(codingSession.containerId, ["cat", data.path]);
    return content;
  });

export const getGitStatus = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(z.object({ sessionId: z.string() }))
  .handler(async ({ data, context }) => {
    const codingSession = await requireSessionOwnership(data.sessionId, context.session);
    const output = await execInContainer(
      codingSession.containerId,
      ["git", "-C", "/workspace", "diff", "--stat"],
      { stdoutOnly: true },
    );
    return output;
  });

export const getFileDiff = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      sessionId: z.string(),
      path: z.string().refine((p) => !p.includes(".."), "Path traversal not allowed"),
    }),
  )
  .handler(async ({ data, context }) => {
    const codingSession = await requireSessionOwnership(data.sessionId, context.session);
    // Try to find the git root, then diff relative to it
    let gitRoot: string;
    try {
      gitRoot = (
        await execInContainer(
          codingSession.containerId,
          [
            "git",
            "-C",
            data.path.substring(0, data.path.lastIndexOf("/")),
            "rev-parse",
            "--show-toplevel",
          ],
          { stdoutOnly: true },
        )
      ).trim();
    } catch {
      return null; // not a git repo
    }
    const output = await execInContainer(
      codingSession.containerId,
      ["git", "-C", gitRoot, "diff", "--", data.path],
      { stdoutOnly: true },
    );
    return output || null;
  });

/**
 * Parse `git status --porcelain` output into a map of path → status code.
 * Keys include absolute paths, direct child names, and parent directories.
 */
export function parseGitPorcelain(
  porcelainOutput: string,
  gitRoot: string,
  listPath: string,
): Record<string, string> {
  const map: Record<string, string> = {};
  const listDir = listPath.endsWith("/") ? listPath.slice(0, -1) : listPath;
  const listDirRel = listDir.startsWith(gitRoot + "/") ? listDir.slice(gitRoot.length + 1) : "";

  // Porcelain v1: "XY path" or "XY old -> new" for renames
  // X = index status, Y = worktree status
  const porcelainLine = /^(.)(.) (.+)$/;
  for (const line of porcelainOutput.split("\n")) {
    const match = line.match(porcelainLine);
    if (!match) continue;
    const [, indexStatus, workStatus, rawPath] = match;
    const code = (indexStatus + workStatus).trim() || "M";
    let relPath = rawPath;
    if (relPath.includes(" -> ")) relPath = relPath.split(" -> ")[1];

    // Store by absolute path
    map[`${gitRoot}/${relPath}`] = code;

    // Store by direct child name relative to listed directory
    if (listDirRel) {
      if (relPath.startsWith(listDirRel + "/")) {
        const rest = relPath.slice(listDirRel.length + 1);
        const directChild = rest.split("/")[0];
        if (!map[directChild]) map[directChild] = code;
      }
    } else {
      const directChild = relPath.split("/")[0];
      if (!map[directChild]) map[directChild] = code;
    }

    // Mark parent directories as modified
    const segments = relPath.split("/");
    let dir = gitRoot;
    for (let i = 0; i < segments.length - 1; i++) {
      dir += "/" + segments[i];
      if (!map[dir]) map[dir] = "M";
    }
  }

  return map;
}
