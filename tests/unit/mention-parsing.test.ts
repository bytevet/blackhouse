import { describe, it, expect } from "vitest";
import { parseMentions, mentionedHandles, mentions } from "../../server/lib/mentions.js";

describe("parseMentions", () => {
  it("finds a mention at the start of a message", () => {
    expect(mentionedHandles("@scout summarise the repo")).toEqual(["scout"]);
  });

  it("finds a mention mid-message", () => {
    expect(mentionedHandles("hey @reviewer take a look")).toEqual(["reviewer"]);
  });

  it("finds several distinct mentions in order", () => {
    expect(mentionedHandles("@scout and @backend, then @reviewer")).toEqual([
      "scout",
      "backend",
      "reviewer",
    ]);
  });

  it("dedupes repeated mentions of the same agent", () => {
    // One run per agent per message, however many times it is named —
    // otherwise "@scout ... @scout" bills two container runs for one request.
    expect(mentionedHandles("@scout do it, @scout really")).toEqual(["scout"]);
  });

  it("is case-insensitive and normalises to lowercase", () => {
    expect(mentionedHandles("@Scout and @REVIEWER")).toEqual(["scout", "reviewer"]);
  });

  it("does not treat an email address as a mention", () => {
    // The `@` is preceded by a word character, so it cannot open a mention.
    expect(mentionedHandles("mail dana@example.com about it")).toEqual([]);
  });

  it("does not mention from inside an npm scope", () => {
    expect(mentionedHandles("install foo@1.2.3 and bar@latest")).toEqual([]);
  });

  it("ignores mentions inside inline code", () => {
    expect(mentionedHandles("use `@types/node` here")).toEqual([]);
  });

  it("ignores mentions inside a fenced code block", () => {
    const body = [
      "look at this:",
      "```ts",
      "// @scout should not fire",
      "const x = 1;",
      "```",
    ].join("\n");
    expect(mentionedHandles(body)).toEqual([]);
  });

  it("still finds mentions outside a fence that also contains one", () => {
    const body = ["@reviewer check:", "```", "@scout ignored", "```"].join("\n");
    expect(mentionedHandles(body)).toEqual(["reviewer"]);
  });

  it("handles an unterminated fence by treating the rest as code", () => {
    expect(mentionedHandles("start\n```\n@scout trailing")).toEqual([]);
  });

  it("stops the handle at trailing punctuation", () => {
    expect(mentionedHandles("@scout, please")).toEqual(["scout"]);
    expect(mentionedHandles("ask @backend.")).toEqual(["backend"]);
    expect(mentionedHandles("(@reviewer)")).toEqual(["reviewer"]);
  });

  it("accepts hyphens and underscores inside a handle", () => {
    expect(mentionedHandles("@front-end and @back_end")).toEqual(["front-end", "back_end"]);
  });

  it("rejects a bare @ and a handle starting with punctuation", () => {
    expect(mentionedHandles("@ nobody")).toEqual([]);
    expect(mentionedHandles("@-nope")).toEqual([]);
  });

  it("reports offsets that select the mention text", () => {
    const body = "hey @scout there";
    const [m] = parseMentions(body);
    expect(body.slice(m.start, m.end)).toBe("@scout");
  });

  it("returns nothing for empty or handle-free bodies", () => {
    expect(mentionedHandles("")).toEqual([]);
    expect(mentionedHandles("no handles here")).toEqual([]);
  });
});

describe("mentions()", () => {
  it("matches with or without the leading @, case-insensitively", () => {
    expect(mentions("ping @Scout", "scout")).toBe(true);
    expect(mentions("ping @scout", "@SCOUT")).toBe(true);
    expect(mentions("ping @scout", "reviewer")).toBe(false);
  });
});
