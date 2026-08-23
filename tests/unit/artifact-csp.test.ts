import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARTIFACT_CSP, artifactBodyHeaders } from "../../server/lib/artifact-csp.js";

/**
 * The sandbox around an agent's artifact is one line long, and deleting a
 * token from it is invisible.
 *
 * Everything an agent submits as an `html` artifact is model-authored code that
 * this codebase defines as untrusted, and two strings are the entire boundary
 * around it: the CSP the body is served under, and the `sandbox` attribute on
 * the frame that renders it. Adding `allow-same-origin` to either one hands the
 * document this origin's cookies, storage and `parent.document` — and the card
 * still renders, the tests still pass, and nothing anywhere says the isolation
 * is gone. Adding `https:` back to the CSP re-opens the exfiltration path a
 * sandboxed document otherwise does not have.
 *
 * Neither regression has a behavioural test that could catch it, which is why
 * these are assertions on the text itself. Same reasoning as
 * `tests/unit/agent-skills.test.ts`: the failure is silent in exactly the place
 * nobody looks.
 */

describe("the artifact CSP", () => {
  it("sandboxes the document as a header, not only as an iframe attribute", () => {
    // As a header the sandbox survives the document being opened top-level in
    // a new tab, which is what the card's "open full pane" link does.
    expect(ARTIFACT_CSP).toContain("sandbox");
    expect(ARTIFACT_CSP).toContain("allow-scripts");
  });

  it("denies everything by default", () => {
    expect(ARTIFACT_CSP).toContain("default-src 'none'");
  });

  it("never grants allow-same-origin", () => {
    expect(ARTIFACT_CSP).not.toContain("allow-same-origin");
  });

  it("names no external scheme", () => {
    // `script-src 'unsafe-inline' https:` and `img-src https:` used to be in
    // here, which let an artifact reach — and exfiltrate to — any host on the
    // internet from inside a workspace whose agents sit behind an egress
    // allowlist. `SKILL.md` already promises agents that external resources
    // may not load; this is the code keeping that promise.
    expect(ARTIFACT_CSP).not.toContain("https:");
    expect(ARTIFACT_CSP).not.toContain("http:");
  });

  it("ships nosniff with every body", () => {
    // The body is attacker-controlled: without this, a `text/plain` artifact
    // whose first bytes look like markup can be sniffed into HTML and run.
    const headers = artifactBodyHeaders("text/plain; charset=utf-8");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Content-Security-Policy"]).toBe(ARTIFACT_CSP);
  });
});

describe("no artifact frame is granted a same origin", () => {
  const FRAMES = [
    join("src", "components", "result-viewer.tsx"),
    join("src", "components", "channel", "artifact-card.tsx"),
  ];

  /**
   * Every `sandbox="…"` attribute in the file.
   *
   * The attribute values, not a grep for the word: both of these files explain
   * in a comment *why* `allow-same-origin` is absent, and a test that failed on
   * the explanation would be a test that pressures the next person to delete
   * the explanation.
   */
  function sandboxAttributes(source: string): string[] {
    return [...source.matchAll(/sandbox="([^"]*)"/g)].map((m) => m[1]!);
  }

  for (const path of FRAMES) {
    it(`${path} keeps its iframe opaque-origin`, () => {
      const values = sandboxAttributes(readFileSync(path, "utf8"));
      expect(values.length, "expected a sandboxed iframe in this file").toBeGreaterThan(0);
      for (const value of values) {
        expect(value).toContain("allow-scripts");
        // The one token. `allow-scripts` plus `allow-same-origin` is not a
        // sandbox at all — the framed document can then script this page.
        expect(value).not.toContain("allow-same-origin");
      }
    });
  }
});
