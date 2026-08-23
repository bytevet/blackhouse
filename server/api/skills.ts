import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SKILLS_DIR = join(process.cwd(), "agent", "skills");

/**
 * One skill, described by what is actually on disk.
 *
 * The file list used to be typed out here by hand, and it had already drifted:
 * `browser-shim.sh` shipped in `agent/skills/blackhouse/` and was referenced by
 * SKILL.md, but was missing from the list — so no agent ever received it. A
 * hardcoded manifest beside the directory it describes is a manifest that goes
 * stale the first time someone adds a script, and nothing fails loudly when it
 * does: the agent simply finds the file absent at the moment it tries to use it.
 */
const DESCRIPTIONS: Record<string, string> = {
  blackhouse:
    "Blackhouse agent tools — post to channels, publish artifacts, set your status line, drive the embedded browser, and request a dispatch to another agent",
};

/**
 * Names we are willing to serve. Anything else is not a skill file.
 *
 * The leading character is restricted deliberately. macOS writes AppleDouble
 * sidecars (`._post.sh`) beside real files whenever the directory crosses a
 * filesystem that cannot hold its extended attributes — a `tar` from a Mac into
 * a Linux container does exactly that — and those matched a name-shaped pattern
 * well enough to be advertised as skill files. The manifest then told agents to
 * download sixteen files for a directory containing eight, and the sidecars are
 * binary, so anything that ran one would get a syntax error rather than a
 * missing-file error. Editor leftovers (`.post.sh.swp`) fail the same way.
 */
const SERVABLE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(sh|md)$/;

function readIndex() {
  let skillDirs: string[] = [];
  try {
    skillDirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return { skills: [] };
  }

  return {
    skills: skillDirs.map((name) => ({
      name,
      description: DESCRIPTIONS[name] ?? `Blackhouse skill: ${name}`,
      files: readdirSync(join(SKILLS_DIR, name), { withFileTypes: true })
        .filter((e) => e.isFile() && SERVABLE.test(e.name))
        .map((e) => e.name)
        // SKILL.md first: it is the one file an installer that only understands
        // documentation will look for, and the one a human reads first.
        .sort((a, b) => (a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a.localeCompare(b))),
    })),
  };
}

const app = new Hono()
  .get("/index.json", (c) => {
    // Read per request rather than at import: in development the scripts are
    // edited while the server is up, and a manifest cached at boot would send
    // agents a list that no longer matches what the file route will serve.
    return c.json(readIndex());
  })

  .get("/:skillName/:fileName", (c) => {
    const skillName = c.req.param("skillName");
    const fileName = c.req.param("fileName");

    /**
     * Strict allowlist, not a `..` blocklist.
     *
     * The previous guard rejected literal `..` only. Hono percent-decodes path
     * params, so a traversal does not have to contain a literal `..` by the
     * time it is read here, and this route reads files off the server's disk
     * with no auth in front of it. Matching the shape of a legitimate name is
     * the check that does not depend on enumerating the ways in.
     */
    if (!/^[A-Za-z0-9_-]+$/.test(skillName) || !SERVABLE.test(fileName)) {
      return c.notFound();
    }

    try {
      const content = readFileSync(join(SKILLS_DIR, skillName, fileName), "utf-8");
      const contentType = fileName.endsWith(".sh")
        ? "application/x-shellscript; charset=utf-8"
        : "text/markdown; charset=utf-8";
      return c.text(content, 200, { "Content-Type": contentType });
    } catch {
      return c.notFound();
    }
  });

export default app;
