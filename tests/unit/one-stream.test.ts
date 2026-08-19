import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * One EventSource per tab.
 *
 * `server/api/stream.ts` multiplexes by topic precisely so that a tab opens one
 * connection rather than one per room, and browsers cap concurrent connections
 * to an origin at around six. Nothing enforced that on the client, and moving
 * the sidebar into a shell is exactly the change that puts it at risk: the
 * obvious way to give the rail live roster updates is to hand the shell its own
 * `useChannelStream` and leave the channel page holding one too.
 *
 * That would work. It would look correct in development. And it would cost
 * every user one of their handful of connections for the lifetime of the tab,
 * with nothing on screen to suggest anything was wrong — which is why this is a
 * test and not a comment.
 */

const SRC = "src";

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("the SSE connection stays singular", () => {
  it("has exactly one caller of useChannelStream", () => {
    const callers = walk(SRC).filter((path) => {
      // The hook's own definition declares it rather than calling it.
      if (path.endsWith(join("hooks", "use-channel-stream.ts"))) return false;
      return /useChannelStream\s*\(/.test(readFileSync(path, "utf8"));
    });

    expect(callers, `expected one caller, found: ${callers.join(", ") || "none"}`).toEqual([
      join("src", "components", "workspace", "workspace-context.tsx"),
    ]);
  });

  it("gives rooms a way to attach without opening their own", () => {
    // The escape valve that makes the rule above followable: a channel still
    // needs its `channel:<id>` frames, and `useStreamTopic` is how it gets them.
    const provider = readFileSync(
      join("src", "components", "workspace", "workspace-context.tsx"),
      "utf8",
    );
    expect(provider).toContain("export function useStreamTopic");

    const channel = readFileSync(
      join("src", "components", "channel", "use-channel-data.ts"),
      "utf8",
    );
    expect(channel).toContain("useStreamTopic");
    expect(channel).toContain("`channel:${channelId}`");
  });

  it("keeps the workspace topic on the shared connection", () => {
    // Roster and agent-status frames arrive on `workspace`. If it ever stopped
    // being subscribed, the rail would silently freeze at its first paint.
    const provider = readFileSync(
      join("src", "components", "workspace", "workspace-context.tsx"),
      "utf8",
    );
    expect(provider).toMatch(/\["workspace", \.\.\.extraTopics\]/);
  });
});
