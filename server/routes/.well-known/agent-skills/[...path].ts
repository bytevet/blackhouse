import { defineEventHandler, getRouterParam, setResponseHeader } from "h3";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SKILLS_DIR = join(process.cwd(), "skills");

const INDEX = {
  skills: [
    {
      name: "blackhouse",
      description: "Blackhouse session tools — submit visual results and update session status",
      files: ["SKILL.md"],
    },
  ],
};

export default defineEventHandler((event) => {
  const path = getRouterParam(event, "path") ?? "";

  if (path === "index.json") {
    setResponseHeader(event, "content-type", "application/json");
    return INDEX;
  }

  // Serve skill files: blackhouse/SKILL.md
  const parts = path.split("/");
  if (parts.length === 2) {
    const [skillName, fileName] = parts;
    // Prevent path traversal
    if (skillName.includes("..") || fileName.includes("..")) {
      return new Response("Not found", { status: 404 });
    }

    try {
      const content = readFileSync(join(SKILLS_DIR, skillName, fileName), "utf-8");
      setResponseHeader(event, "content-type", "text/markdown; charset=utf-8");
      return content;
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }

  return new Response("Not found", { status: 404 });
});
