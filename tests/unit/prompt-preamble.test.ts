import { describe, it, expect } from "vitest";
import { channelPreamble, joinPreamble } from "../../server/agents/prompt-preamble.js";
import { planInjection, normalizePromptText } from "../../server/agents/injector.js";
import { PROFILES } from "../../server/agents/adapters/profiles.js";

/**
 * The agent is told which channel it is answering in.
 *
 * Before this, the PTY received the human's message body and nothing else. Both
 * `post.sh` and `submit-result.sh` require a `#channel`, so they were asking
 * the agent for a fact it had never been given — and the observed result was an
 * agent publishing a report to an external service, because that was the only
 * delivery path it could complete on its own.
 *
 * The line is written into a live terminal a human is watching, so its shape is
 * a real constraint rather than a detail: it has to survive
 * `normalizePromptText`, sit inside the bracketed paste, and not turn into a
 * stray Enter on a profile that has no paste mode.
 */

const ESC = String.fromCharCode(0x1b);

const text = (steps: ReturnType<typeof planInjection>) =>
  Buffer.concat(steps.filter((s) => s.kind === "body").map((s) => s.bytes)).toString("utf8");

describe("channelPreamble", () => {
  it("names the channel", () => {
    expect(channelPreamble({ slug: "general", bracketedPaste: true })).toContain("#general");
  });

  it("tolerates a leading hash", () => {
    expect(channelPreamble({ slug: "#general", bracketedPaste: true })).not.toContain("##");
  });

  it("renders nothing when there is no channel", () => {
    // `runs.channelId` is nullable and the raw inject endpoint has no channel at
    // all. An agent without the line is where we started; one told
    // `channel #undefined` is worse.
    for (const slug of [null, undefined, "", "   "]) {
      expect(channelPreamble({ slug, bracketedPaste: true })).toBe("");
    }
  });

  it("stays inside one terminal line", () => {
    const line = channelPreamble({ slug: "a".repeat(300), bracketedPaste: true });
    expect(line.length).toBeLessThan(110);
  });
});

describe("joining onto the prompt", () => {
  it("uses a blank line when the profile pastes", () => {
    expect(joinPreamble("P", "body", true)).toBe("P\n\nbody");
  });

  it("uses no newline at all when the profile does not paste", () => {
    /**
     * Without bracketed paste the bytes are typed as keystrokes, and a newline
     * is Enter on most TUIs — a two-line preamble would submit itself and leave
     * the real prompt behind in an empty composer. This is the whole reason the
     * join is profile-dependent.
     */
    const joined = joinPreamble("P", "body", false);
    expect(joined).not.toContain("\n");
    expect(joined).toBe("P body");
  });

  it("leaves an empty body empty", () => {
    // `planInjection` returns before the submit key on an empty body so an
    // interrupt does not submit an empty composer. A preamble must not defeat
    // that by making the body non-empty.
    expect(joinPreamble("P", "", true)).toBe("");
  });
});

describe("planInjection with a preamble", () => {
  const preamble = channelPreamble({ slug: "general", bracketedPaste: true });

  it("puts the preamble inside the paste, not before it", () => {
    const steps = planInjection("do the thing", PROFILES["claude-code"], { preamble });
    const kinds = steps.map((s) => s.kind);

    // Outside a paste the bytes are keystrokes, where a leading `/`, `#`, `!`
    // or `@` triggers slash-command, memory, bash or file-mention modes.
    expect(kinds.indexOf("paste-start")).toBeLessThan(kinds.indexOf("body"));
    expect(kinds.lastIndexOf("body")).toBeLessThan(kinds.indexOf("paste-end"));
    expect(text(steps)).toBe(`${preamble}\n\ndo the thing`);
  });

  it("does not change the step shape or the timing", () => {
    const withOut = planInjection("hi", PROFILES["claude-code"], {});
    const withIn = planInjection("hi", PROFILES["claude-code"], { preamble });
    expect(withIn.map((s) => s.kind)).toEqual(withOut.map((s) => s.kind));
    expect(withIn.at(-1)!.kind).toBe("submit");
    expect(withIn.at(-2)!.delayAfterMs).toBe(withOut.at(-2)!.delayAfterMs);
  });

  it("still refuses to submit an empty prompt", () => {
    // An interrupt-only injection is meaningful — stop what you are doing — and
    // must not also press Enter on an empty composer. A preamble would defeat
    // that guard by making the body non-empty, which is why `joinPreamble`
    // returns the body untouched when there is no body.
    //
    // The guard is on genuinely empty text, not on whitespace: `"   "` has
    // always been pasted and submitted, and this is not the change that should
    // alter it.
    const steps = planInjection("", PROFILES["claude-code"], { preamble, mode: "interrupt" });
    expect(steps.some((s) => s.kind === "submit")).toBe(false);
    expect(steps.map((s) => s.kind)).toEqual(["interrupt"]);
  });

  it("strips control characters out of the preamble too", () => {
    // Proves the join happens before normalisation. The preamble is
    // server-built today, but the encoder must not be the thing that assumes
    // that: ESC in the injected stream drives the TUI's key bindings.
    const steps = planInjection("body", PROFILES["claude-code"], {
      preamble: `A${ESC}[Bevil`,
    });
    expect(text(steps)).not.toContain(ESC);
  });

  it("emits one line on a profile with no bracketed paste", () => {
    const custom = PROFILES.custom;
    expect(custom.bracketedPaste).toBe(false);
    const steps = planInjection("body", custom, {
      preamble: channelPreamble({ slug: "general", bracketedPaste: custom.bracketedPaste }),
    });
    expect(text(steps)).not.toContain("\n");
  });
});

describe("normalizePromptText keeps what the preamble needs", () => {
  it("preserves the newlines the paste form relies on", () => {
    expect(normalizePromptText("a\n\nb")).toBe("a\n\nb");
  });
});
