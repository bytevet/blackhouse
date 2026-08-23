import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import skillsApp from "../../server/api/skills.js";

/**
 * The skill files are how an agent talks back.
 *
 * `agent/skills/blackhouse/` holds the scripts an agent runs to post to a
 * channel, mention a teammate and submit an artifact. Two independent lists
 * used to describe that directory — a hardcoded `INDEX` in the route, and an
 * implicit one in the entrypoint that fetched `SKILL.md` and nothing else —
 * and both had drifted from it. The visible result was an agent finishing a
 * task and reporting that it "couldn't submit this as a channel card" because
 * the scripts its own instructions named were not in the container.
 *
 * Nothing about that failure is loud: the install step prints success, and the
 * absence is only discovered by an agent mid-task. So the manifest is checked
 * against the directory here instead.
 */

const SKILLS_DIR = join("agent", "skills");

describe("the skill manifest describes what is on disk", () => {
  it("lists every script and doc in every skill directory", async () => {
    const res = await skillsApp.request("/index.json");
    expect(res.status).toBe(200);
    const index = (await res.json()) as {
      skills: Array<{ name: string; files: string[] }>;
    };

    const onDisk = readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(index.skills.map((s) => s.name).sort()).toEqual([...onDisk].sort());

    for (const skill of index.skills) {
      const expected = readdirSync(join(SKILLS_DIR, skill.name), { withFileTypes: true })
        .filter((e) => e.isFile() && /^[A-Za-z0-9][A-Za-z0-9._-]*\.(sh|md)$/.test(e.name))
        .map((e) => e.name);
      // `browser-shim.sh` is the one that was missing. Comparing sets rather
      // than naming it keeps the next addition covered too.
      expect(new Set(skill.files)).toEqual(new Set(expected));
    }
  });

  it("serves each listed file", async () => {
    const index = (await (await skillsApp.request("/index.json")).json()) as {
      skills: Array<{ name: string; files: string[] }>;
    };

    for (const skill of index.skills) {
      for (const file of skill.files) {
        const res = await skillsApp.request(`/${skill.name}/${file}`);
        expect(res.status, `${skill.name}/${file}`).toBe(200);
        expect((await res.text()).length).toBeGreaterThan(0);
      }
    }
  });

  it("refuses anything that is not a skill file", async () => {
    // The route reads files off the server's disk with no auth in front of it,
    // and Hono percent-decodes path params — so a traversal need not still
    // contain a literal ".." by the time the handler sees it.
    for (const path of [
      "/blackhouse/..%2f..%2fpackage.json",
      "/blackhouse/../../package.json",
      "/..%2f..%2fetc/passwd",
      "/blackhouse/.env",
      "/blackhouse/index.ts",
      // macOS AppleDouble sidecar: name-shaped, binary, and not a skill.
      "/blackhouse/._post.sh",
      "/blackhouse/.post.sh.swp",
    ]) {
      const res = await skillsApp.request(path);
      expect(res.status, path).not.toBe(200);
    }
  });
});

describe("the entrypoint installs the whole skill", () => {
  const entrypoint = readFileSync(join("agent", "entrypoint.sh"), "utf8");

  it("fetches the index rather than one hardcoded file", () => {
    expect(entrypoint).toContain(".well-known/agent-skills/index.json");
  });

  it("makes the downloaded scripts executable", () => {
    // A git checkout carries the mode bit; an HTTP response body does not.
    expect(entrypoint).toMatch(/chmod \+x/);
  });

  it("does not claim success when no script landed", () => {
    // The old installer printed "Skills installed" after fetching SKILL.md
    // alone, which is why this went unnoticed for so long.
    expect(entrypoint).toMatch(/WARNING: skill index fetch failed or yielded no scripts/);
  });
});

/**
 * The entrypoint is the only place the system prompt reaches a CLI.
 *
 * It wrote the prompt to a file and exported its path — and then handed that
 * path to nobody. Every agent therefore ran with whatever system prompt its CLI
 * ships by default, which is why one published an HTML report to an external
 * artifact service instead of into the channel that asked for it.
 *
 * These are textual assertions on a shell script for the same reason the block
 * above is: none of it runs anywhere a unit test can reach, and the failure it
 * guards against is silent in exactly the place nobody looks.
 */
describe("the entrypoint hands the system prompt to the CLI", () => {
  const entrypoint = readFileSync(join("agent", "entrypoint.sh"), "utf8");

  it("always creates the prompt file, even with SYSTEM_PROMPT unset", () => {
    // `AGENT_COMMAND` may contain `$(cat "$BLACKHOUSE_SYSTEM_PROMPT_FILE")`.
    // With the variable unset that is `$(cat "")` — `cat` fails, `exec` runs a
    // command line missing an argument, and the container comes up with no CLI
    // in it. So the write must not sit behind a non-empty check.
    expect(entrypoint).toMatch(
      /printf '%s\\n' "\$SYSTEM_PROMPT" >"\$BLACKHOUSE_SYSTEM_PROMPT_FILE"/,
    );
    expect(entrypoint).not.toMatch(/if \[ -n "\$SYSTEM_PROMPT" \]/);
    expect(entrypoint).toContain("export BLACKHOUSE_SYSTEM_PROMPT_FILE");
  });

  it("passes the prompt to Claude Code on the command line", () => {
    expect(entrypoint).toContain("--append-system-prompt");
  });

  it("writes the per-CLI instruction files for the CLIs with no flag", () => {
    // Codex and `agy` expose no system-prompt flag, so the prompt is delivered
    // as the file each one reads at startup.
    expect(entrypoint).toContain('"$HOME/.codex/AGENTS.md"');
    expect(entrypoint).toContain('"$HOME/.gemini/GEMINI.md"');
  });

  it("overwrites those files rather than preserving a stale copy", () => {
    // They live in the per-agent state volume, which survives restarts. `cp -n`
    // would mean an edited prompt is outlived by the one written on first boot.
    expect(entrypoint).not.toMatch(/cp -n "\$BLACKHOUSE_SYSTEM_PROMPT_FILE"/);
  });

  it("guards the Claude Code fallback with a contains check", () => {
    // Two mechanisms now put the flag on the command line: the seeded blueprint
    // and this fallback, which exists because `seed.ts` only inserts blueprints
    // into an empty table and therefore reaches no existing install. The guard
    // is what makes them safe together — a command that already names the file
    // is left alone, so the flag cannot be applied twice.
    expect(entrypoint).toMatch(
      /case "\$AGENT_COMMAND" in\s*\n\s*\*BLACKHOUSE_SYSTEM_PROMPT_FILE\*\) ;;/,
    );
  });
});
