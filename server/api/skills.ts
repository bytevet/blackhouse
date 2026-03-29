import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = new Hono();

const SKILLS_DIR = join(process.cwd(), "agent", "skills");

const INDEX = {
  skills: [
    {
      name: "blackhouse",
      description: "Blackhouse session tools — submit visual results and update session status",
      files: ["SKILL.md", "submit-result.sh", "update-title.sh"],
    },
  ],
};

// ---------------------------------------------------------------------------
// GET /.well-known/agent-skills/* — serve skill index and files
// ---------------------------------------------------------------------------

app.get("/index.json", (c) => {
  return c.json(INDEX);
});

app.get("/:skillName/:fileName", (c) => {
  const skillName = c.req.param("skillName");
  const fileName = c.req.param("fileName");

  // Prevent path traversal
  if (skillName.includes("..") || fileName.includes("..")) {
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
