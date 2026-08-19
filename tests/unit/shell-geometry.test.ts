import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The app shell's shared measurements.
 *
 * Every one of these was reported by a user looking at the running app, and
 * every one was the same failure: a value written out per screen, copied, and
 * then edited in one place only. The top bar was `11px 20px` on `/agents`,
 * `11px 20px` in settings and `10px 18px` on `/agents/:id`; the left rail was
 * 288px on the channels screen and 230px in settings. Nothing was broken
 * enough to fail a test — the layout just moved as you navigated.
 *
 * These assertions are deliberately about the *source*, not about rendering:
 * the defect is a duplicated literal, and a rendering test would pass just as
 * happily against three hard-coded copies that agree today.
 */

const read = (p: string) => readFileSync(p, "utf8");
const css = () => read("src/index.css");

describe("shared shell tokens", () => {
  it("declares the header height and rail width once, at :root", () => {
    const root = css().slice(css().indexOf(":root {"), css().indexOf("html,"));
    expect(root).toMatch(/--bh-header-h:\s*\d+px/);
    expect(root).toMatch(/--bh-rail-w:\s*\d+px/);
    expect(root).toMatch(/--bh-topstrip-h:\s*\d+px/);
  });
});

describe("one top bar, one height", () => {
  it("routes the remaining breadcrumb bar through AppHeader", () => {
    // Only settings still has one. The `/agents` roster and the agent
    // breadcrumb both went when channels and agents moved into one shell —
    // the rail is always on screen now and already says where you are.
    const file = "src/layouts/settings-layout.tsx";
    expect(read(file), `${file} should render AppHeader`).toContain("<AppHeader");
    expect(read(file), `${file} should not hand-roll a header`).not.toMatch(/<header\b/);
  });

  it("takes the bar's height from the token rather than from padding", () => {
    const rule = css().slice(css().indexOf(".bh-app-header {"));
    expect(rule.slice(0, rule.indexOf("}"))).toContain("height: var(--bh-header-h)");
  });

  it("gives the channel screen's two top blocks one shared height", () => {
    // These sit side by side, so a few pixels of difference shows up as a step
    // in the rule across the top of the screen rather than as a size anyone
    // would notice in isolation.
    expect(read("src/components/channel/channel-header.tsx")).toContain(
      'height: "var(--bh-topstrip-h)"',
    );
    expect(read("src/components/channel/channel-sidebar.tsx")).toContain(
      'height: "var(--bh-topstrip-h)"',
    );
  });
});

describe("one rail, one width", () => {
  it("uses the token in both rails", () => {
    expect(read("src/components/channel/channel-sidebar.tsx")).toContain(
      'width: "var(--bh-rail-w)"',
    );
    const nav = css().slice(css().indexOf(".bh-settings-nav {"));
    expect(css().slice(css().indexOf("@media (min-width: 768px)"))).toContain(
      "width: var(--bh-rail-w)",
    );
    expect(nav).not.toMatch(/width:\s*230px/);
  });
});

describe("modal dialogs are centred", () => {
  it("restores the margin Tailwind's preflight resets", () => {
    // A native modal `<dialog>` centres via the UA stylesheet's `margin: auto`.
    // Preflight sets `margin: 0` on `*`, which wins — and pinned every dialog
    // in the app to the top-left corner until this rule was added.
    const rule = css().slice(css().indexOf("dialog:modal"));
    expect(rule.slice(0, rule.indexOf("}"))).toContain("margin: auto");
  });
});

describe("creating an agent is a dialog over the roster", () => {
  it("renders as a Dialog rather than a page", () => {
    const src = read("src/pages/create-agent.tsx");
    expect(src).toContain("<Dialog");
    // The full-page shell it used to paint. Its presence would mean the wizard
    // has gone back to replacing the screen.
    expect(src).not.toContain('minHeight: "100%"');
  });

  it("renders against a background location so a room stays behind it", () => {
    // It used to nest under the roster screen. With the roster folded into the
    // rail there is nothing to nest under, so the modal keeps the room you came
    // from on screen via React Router's background-location idiom. Losing that
    // would leave the dialog floating over an empty content area.
    const app = read("src/App.tsx");
    expect(app).toContain("backgroundLocation");
    expect(app).toMatch(/<Routes location=\{background \?\? location\}>/);
    expect(app).toMatch(/<Route path="\/agents\/new" element=\{<CreateAgentPage \/>\} \/>/);
  });
});
