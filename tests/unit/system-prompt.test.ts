import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { BLACKHOUSE_BASE_PROMPT, composeSystemPrompt } from "../../server/agents/system-prompt.js";

/**
 * The base prompt is the only thing that tells an agent this harness exists.
 *
 * Before it, `SYSTEM_PROMPT` was pushed only when a blueprint or an agent had
 * one, and nothing seeds either — so no agent ever received a system prompt at
 * all. Asked for an HTML report, one built it and published it to an external
 * artifact service its CLI ships with; the humans who asked never saw it. These
 * tests pin the two properties that failure depended on: the base is always
 * present, and an operator's own prompt cannot displace it.
 */
describe("composeSystemPrompt layers the harness facts under the operator's text", () => {
  const base = { handle: "scout", blueprintPrompt: null, agentOverride: null };

  it("always includes the base, with no operator prompt at all", () => {
    const composed = composeSystemPrompt(base);
    expect(composed).toContain("Blackhouse workspace");
    expect(composed).toContain("post.sh");
  });

  it("keeps the base when a blueprint prompt is set", () => {
    const composed = composeSystemPrompt({ ...base, blueprintPrompt: "Be terse." });
    expect(composed).toContain("Blackhouse workspace");
    expect(composed).toContain("Be terse.");
  });

  it("lets the agent override replace the blueprint prompt — but never the base", () => {
    const composed = composeSystemPrompt({
      ...base,
      blueprintPrompt: "Be terse.",
      agentOverride: "Be exhaustive.",
    });
    expect(composed).toContain("Be exhaustive.");
    expect(composed).not.toContain("Be terse.");
    // The whole point: a personality override is not an opt-out from knowing
    // where the output goes.
    expect(composed).toContain("Blackhouse workspace");
    expect(composed).toContain("submit-result.sh");
  });

  it("treats a whitespace-only override as no override", () => {
    // "" is what an operator types to mean "inherit"; so is a stray newline.
    const composed = composeSystemPrompt({ ...base, blueprintPrompt: "  \n  " });
    expect(composed).toBe(composeSystemPrompt(base));
  });

  it("interpolates the handle and leaves no placeholder behind", () => {
    const composed = composeSystemPrompt({ ...base, handle: "reviewer" });
    expect(composed).toContain("@reviewer");
    expect(composed).not.toContain("{handle}");
  });

  it("does not double the sigil when a handle was stored with one", () => {
    // Handles are stored bare — `server/lib/mentions.ts` strips a leading `@`
    // before matching — but the template supplies its own, so a row that kept
    // the sigil would otherwise read "@@scout".
    expect(composeSystemPrompt({ ...base, handle: "@scout" })).toContain("@scout");
    expect(composeSystemPrompt({ ...base, handle: "@scout" })).not.toContain("@@");
  });

  it("never emits a double blank line", () => {
    // This string is passed through `--append-system-prompt "$(cat …)"`, so
    // stray padding at the seam ends up quoted into a transcript.
    for (const input of [
      base,
      { ...base, blueprintPrompt: "Be terse." },
      { ...base, blueprintPrompt: "\n\nBe terse.\n\n" },
      { ...base, agentOverride: "Be exhaustive." },
    ]) {
      expect(composeSystemPrompt(input)).not.toMatch(/\n{3,}/);
    }
  });
});

/**
 * The prompt names scripts, and the scripts are shipped separately.
 *
 * `tests/unit/agent-skills.test.ts` enforces the same property for the skill
 * manifest, and for the same reason: an agent told to run `submit-result.sh`
 * when no such file was installed reported that it "couldn't submit this as a
 * channel card". A prompt that names a script we no longer ship fails the same
 * way, one layer up.
 */
describe("the base prompt names scripts that actually exist", () => {
  const shipped = new Set(readdirSync(join("agent", "skills", "blackhouse")));

  for (const script of ["post.sh", "submit-result.sh"]) {
    it(`names ${script}, and ${script} is on disk`, () => {
      expect(BLACKHOUSE_BASE_PROMPT).toContain(script);
      expect(shipped.has(script)).toBe(true);
    });
  }

  it("names no script that is not shipped", () => {
    const named = BLACKHOUSE_BASE_PROMPT.match(/[a-z][a-z-]*\.sh/g) ?? [];
    expect(named.length).toBeGreaterThan(0);
    for (const script of new Set(named)) {
      expect(shipped.has(script), `${script} is named in the prompt but not shipped`).toBe(true);
    }
  });
});
