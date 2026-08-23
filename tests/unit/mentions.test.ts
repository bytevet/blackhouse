import { describe, it, expect } from "vitest";
import {
  MENTION_TRIGGER,
  applyMention,
  findMentionQuery,
  mentionedHandles,
  parseMentions,
  segmentBody,
} from "@/components/channel/mentions";

/**
 * The mention rule is a contract between two parsers: the composer opens its
 * autocomplete on it, and the server creates a `run` per handle it finds. A
 * divergence either shows a chip that never dispatches, or dispatches an agent
 * the author never visibly mentioned. These tests pin the rule.
 */

const ROSTER = ["scout", "reviewer", "backend", "frontend"];

describe("MENTION_TRIGGER", () => {
  it("is the prototype's regex, verbatim", () => {
    expect(MENTION_TRIGGER.source).toBe("(^|\\s)@[\\w-]*$");
  });

  it("fires on a bare @ at the start and after whitespace", () => {
    expect(MENTION_TRIGGER.test("@")).toBe(true);
    expect(MENTION_TRIGGER.test("hey @")).toBe(true);
    expect(MENTION_TRIGGER.test("hey @sc")).toBe(true);
    expect(MENTION_TRIGGER.test("hey @sc-out")).toBe(true);
  });

  it("does not fire mid-word, so email addresses never open the listbox", () => {
    expect(MENTION_TRIGGER.test("mail a@b")).toBe(false);
    expect(MENTION_TRIGGER.test("a@b.com")).toBe(false);
  });

  it("stops firing once the handle is committed with a space", () => {
    expect(MENTION_TRIGGER.test("@scout ")).toBe(false);
    expect(MENTION_TRIGGER.test("@scout summarise")).toBe(false);
  });
});

describe("parseMentions", () => {
  it("finds a handle at the start of the body, with offsets", () => {
    expect(parseMentions("@scout summarise the checkout flow")).toEqual([
      { handle: "scout", index: 0, length: 6 },
    ]);
  });

  it("finds handles mid-string and reports offsets that round-trip", () => {
    const body = "hey @scout and @reviewer, take a look";
    const found = parseMentions(body);
    expect(found.map((m) => m.handle)).toEqual(["scout", "reviewer"]);
    for (const m of found) {
      expect(body.slice(m.index, m.index + m.length)).toBe(`@${m.handle}`);
    }
    expect(found[0].index).toBe(4);
    expect(found[1].index).toBe(15);
  });

  it("does not match an email address", () => {
    expect(parseMentions("ping a@b.com when done")).toEqual([]);
    expect(parseMentions("dana.okafor@acme.example")).toEqual([]);
    expect(mentionedHandles("cc: ops@acme.com and @scout")).toEqual(["scout"]);
  });

  it("stops the handle at trailing punctuation", () => {
    expect(parseMentions("@scout, then @reviewer.")).toEqual([
      { handle: "scout", index: 0, length: 6 },
      { handle: "reviewer", index: 13, length: 9 },
    ]);
    expect(parseMentions("ask @backend!")[0]).toEqual({ handle: "backend", index: 4, length: 8 });
  });

  it("keeps hyphens and underscores, which are legal in a handle", () => {
    expect(mentionedHandles("@code-reviewer and @deploy_bot")).toEqual([
      "code-reviewer",
      "deploy_bot",
    ]);
  });

  it("ignores mentions inside fenced code blocks", () => {
    const body = [
      "look at this:",
      "```ts",
      "// @scout owns this file",
      "```",
      "@reviewer ptal",
    ].join("\n");
    const found = parseMentions(body);
    expect(found.map((m) => m.handle)).toEqual(["reviewer"]);
    expect(body.slice(found[0].index, found[0].index + found[0].length)).toBe("@reviewer");
  });

  it("ignores mentions inside an unterminated fence", () => {
    expect(parseMentions("```\n@scout\n")).toEqual([]);
  });

  it("ignores mentions inside inline code", () => {
    expect(parseMentions("the string `@scout` is a literal")).toEqual([]);
    expect(mentionedHandles("`@scout` but really @reviewer")).toEqual(["reviewer"]);
  });

  it("lowercases and dedupes for dispatch, since handles are unique case-insensitively", () => {
    expect(mentionedHandles("@Scout @scout @SCOUT")).toEqual(["scout"]);
  });

  it("does not treat a bare @ as a mention", () => {
    expect(parseMentions("email me @ the usual place")).toEqual([]);
  });
});

describe("segmentBody", () => {
  it("splits text and mention runs in source order", () => {
    expect(segmentBody("hi @scout ok", ROSTER)).toEqual([
      { type: "text", text: "hi " },
      { type: "mention", text: "@scout", handle: "scout", known: true },
      { type: "text", text: " ok" },
    ]);
  });

  it("marks unknown handles so they render as plain text, not a chip", () => {
    const segments = segmentBody("@scout and @ghost", ROSTER);
    expect(segments.filter((s) => s.type === "mention").map((s) => s.known)).toEqual([true, false]);
  });

  it("resolves case-insensitively", () => {
    const [mention] = segmentBody("@Reviewer", ROSTER);
    expect(mention).toEqual({
      type: "mention",
      text: "@Reviewer",
      handle: "Reviewer",
      known: true,
    });
  });

  it("round-trips the original body", () => {
    const body = "cc @scout, see `@reviewer` and a@b.com";
    expect(
      segmentBody(body, ROSTER)
        .map((s) => s.text)
        .join(""),
    ).toBe(body);
  });
});

describe("findMentionQuery", () => {
  it("reports the in-progress handle and where it starts", () => {
    expect(findMentionQuery("hey @sc")).toEqual({ query: "sc", start: 4 });
    expect(findMentionQuery("@")).toEqual({ query: "", start: 0 });
  });

  it("is null once the mention is committed, or when there is none", () => {
    expect(findMentionQuery("@scout ")).toBeNull();
    expect(findMentionQuery("nothing here")).toBeNull();
    expect(findMentionQuery("a@b")).toBeNull();
  });

  it("respects a caret in the middle of the text", () => {
    const text = "hey @sc and more";
    expect(findMentionQuery(text, 7)).toEqual({ query: "sc", start: 4 });
    // Caret past the committed space: no longer a mention in progress.
    expect(findMentionQuery(text, 8)).toBeNull();
  });

  it("lowercases the query so matching is case-insensitive", () => {
    expect(findMentionQuery("@SCo")?.query).toBe("sco");
  });
});

describe("applyMention", () => {
  it("splices the picked handle in and leaves a trailing space", () => {
    expect(applyMention("hey @sc", 7, "scout")).toBe("hey @scout ");
  });

  it("preserves text after the caret", () => {
    expect(applyMention("hey @sc and more", 7, "scout")).toBe("hey @scout  and more");
  });

  it("is a no-op when there is no mention in progress", () => {
    expect(applyMention("hello", 5, "scout")).toBe("hello");
  });
});
