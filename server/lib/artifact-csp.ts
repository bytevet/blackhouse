/**
 * The Content-Security-Policy every agent-authored artifact body is served
 * under.
 *
 * Its own module, and exported rather than inlined at the two call sites, for
 * one reason: this header is the entire security boundary around a document
 * written by a model, and a one-token edit to it — a stray `https:`, an
 * `allow-same-origin` — silently removes that boundary while every behavioural
 * test keeps passing. A named constant is something a test can assert about.
 * `tests/unit/artifact-csp.test.ts` does exactly that.
 *
 * Two decisions worth stating, because both look like oversights:
 *
 * 1. `sandbox allow-scripts` is set as a **CSP directive**, not only as the
 *    iframe's `sandbox` attribute. The iframe attribute covers the card; it
 *    does nothing when the same URL is opened top-level in a new tab, which is
 *    exactly what the card's "open full pane" control does. As a header the
 *    sandbox travels with the response, so the document lands in an opaque
 *    origin either way. `allow-same-origin` is absent, and must stay absent:
 *    granting it alongside `allow-scripts` hands the document this origin's
 *    cookies, storage and `parent.document` — i.e. no sandbox at all.
 *
 * 2. There are no `https:` sources. The previous policy on
 *    `GET /api/agents/:id/results/latest` allowed `script-src 'unsafe-inline'
 *    https:` and `img-src https:`, which let an artifact fetch — and therefore
 *    exfiltrate to — any host on the internet, from a document authored by an
 *    agent that is otherwise held behind an egress allowlist.
 *    `agent/skills/blackhouse/SKILL.md` and `submit-result.sh` already tell
 *    agents that HTML must be self-contained and that "external stylesheets and
 *    scripts may not load in the viewer", so this makes the code match the
 *    contract it already publishes.
 *
 *    Behaviour change, deliberately: an artifact that pulled a chart library
 *    off a CDN used to work by accident and now renders blank. The fix is for
 *    the agent to inline it, which is what it was told to do.
 */
export const ARTIFACT_CSP = [
  "default-src 'none'",
  "img-src data: blob:",
  "style-src 'unsafe-inline'",
  "font-src data:",
  "script-src 'unsafe-inline'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  "sandbox allow-scripts",
].join("; ");

/**
 * Headers for an artifact body response.
 *
 * `nosniff` matters more here than usual: the body is attacker-controlled, and
 * without it a `text/plain` artifact whose first bytes look like markup can be
 * sniffed into `text/html` by a browser and executed.
 */
export function artifactBodyHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Content-Security-Policy": ARTIFACT_CSP,
    "X-Content-Type-Options": "nosniff",
  };
}
