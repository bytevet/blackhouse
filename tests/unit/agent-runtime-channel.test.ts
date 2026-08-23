import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTargetChannel } from "../../server/api/agent-runtime.js";

/**
 * Where an agent's own posts and artifacts land.
 *
 * An agent is never told which channel it is answering in — the PTY carried the
 * human's message body and nothing else — while `post.sh` and
 * `submit-result.sh` both required a `#channel`. The path was therefore
 * unusable without guessing, and the observed result was an agent publishing a
 * report to an external service instead.
 *
 * The run it is answering knows the channel, so the server answers rather than
 * the agent. The rule lives in a pure function for the same reason
 * `canReceiveQueuedRun` does: it decides where a write goes, and that decision
 * should be testable without a database.
 */

describe("resolveTargetChannel", () => {
  it("prefers an explicit channel", () => {
    expect(resolveTargetChannel({ explicitKey: "#other", openRunChannelId: "chan-run" })).toEqual({
      source: "explicit",
      key: "#other",
    });
  });

  it("falls back to the run in flight", () => {
    expect(resolveTargetChannel({ openRunChannelId: "chan-run" })).toEqual({
      source: "run",
      channelId: "chan-run",
    });
  });

  it("reports having nothing rather than picking a default", () => {
    // Silently defaulting to `#general` would put an agent's output in a room
    // nobody was watching. The route turns this into a 409 whose message tells
    // the agent to pass a channel.
    expect(resolveTargetChannel({})).toEqual({ source: "none" });
    expect(resolveTargetChannel({ explicitKey: "   ", openRunChannelId: null })).toEqual({
      source: "none",
    });
  });

  it("treats blank explicit input as absent, not as a channel named nothing", () => {
    expect(resolveTargetChannel({ explicitKey: "  ", openRunChannelId: "chan-run" })).toEqual({
      source: "run",
      channelId: "chan-run",
    });
  });
});

describe("the write path is gated where the prompt cannot be trusted", () => {
  const source = readFileSync(join("server", "api", "agent-runtime.ts"), "utf8");

  it("checks membership before writing to an explicitly named private channel", () => {
    /**
     * The agent reads one flat stream of text, so a human whose message opens
     * with a line imitating the harness preamble is indistinguishable from the
     * harness. That makes the injected channel line a hint and this check the
     * authority.
     */
    expect(source).toContain("channelMembers");
    expect(source).toMatch(/target\.source === "explicit" && channel\.isPrivate/);
  });

  it("answers a non-member with not-found rather than forbidden", () => {
    // A private channel must not confirm it exists, matching how the human-facing
    // routes in `api/channels.ts` handle the same case.
    const block = source.slice(source.indexOf("resolveWritableChannel"));
    expect(block).toContain('error: "Channel not found"');
  });

  it("does not require membership for an inferred channel", () => {
    // `db/seed.ts` creates #general and adds nobody, so demanding membership
    // outright would break every existing deployment the moment it shipped.
    // The run is proof the harness put the agent there.
    expect(source).toMatch(/inferred from the run|source === "run"/);
  });
});

describe("injection holds the mutex across the whole paste", () => {
  /**
   * `pty-hub.write({source:"inject"})` forwards to `inject` with a single step,
   * so driving a multi-chunk paste through it took and released the mutex once
   * per chunk and left `injecting` false in every inter-chunk gap — peer
   * keystrokes were written straight through instead of being buffered, which
   * is the interleaving the mutex exists to prevent.
   *
   * Grep-based on purpose: the bug is a call-site shape, and it regresses by
   * someone reintroducing a loop, not by a behaviour a unit test would observe.
   */
  for (const file of [join("server", "agents", "queue.ts"), join("server", "api", "agents.ts")]) {
    it(`${file} injects rather than looping writes`, () => {
      const source = readFileSync(file, "utf8");
      expect(source).toContain("hub.inject(");
      expect(source).not.toMatch(/hub\.write\([^)]*source:\s*"inject"/s);
    });
  }
});
