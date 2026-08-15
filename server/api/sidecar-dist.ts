import { Hono } from "hono";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import * as tar from "tar-stream";

const SIDECAR_DIR = join(process.cwd(), "agent", "sidecar");

/**
 * Serves the sidecar source as a tarball at
 * `/.well-known/blackhouse/sidecar.tar`.
 *
 * `entrypoint.sh` fetches this at boot and prefers it over the copy baked into
 * the image. Without it, every sidecar change would mean rebuilding three
 * ~3GB agent images — during active development that iteration cost dominates
 * everything else.
 *
 * Layout matters: the entrypoint extracts into a directory and checks for
 * `index.mjs` at its root, discarding the whole override if that file is
 * missing. So entries are packed relative to `agent/sidecar` with no leading
 * directory component.
 *
 * Unauthenticated on purpose. The sidecar runs before it has anything to
 * authenticate with, the contents are already open source in the image, and
 * the endpoint only ever reads from a fixed directory on our own disk.
 */
function packDir(pack: tar.Pack, absDir: string, root: string): void {
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) {
      packDir(pack, abs, root);
      continue;
    }
    if (!entry.isFile()) continue;

    const stat = statSync(abs);
    const buf = readFileSync(abs);
    pack.entry(
      {
        // Normalise to POSIX separators — the extracting side is always Linux.
        name: relative(root, abs).split(sep).join("/"),
        mode: stat.mode & 0o7777,
        mtime: stat.mtime,
        size: buf.length,
      },
      buf,
    );
  }
}

const app = new Hono().get("/sidecar.tar", async (c) => {
  let chunks: Buffer[];
  try {
    const pack = tar.pack();
    const collected: Buffer[] = [];
    const done = new Promise<void>((resolve, reject) => {
      pack.on("data", (chunk: Buffer) => collected.push(chunk));
      pack.on("end", () => resolve());
      pack.on("error", reject);
    });

    packDir(pack, SIDECAR_DIR, SIDECAR_DIR);
    pack.finalize();
    await done;
    chunks = collected;
  } catch (err) {
    // A missing or unreadable directory must not 500 the boot path; the
    // entrypoint treats any failure as "use the baked-in copy".
    console.warn("[blackhouse] could not pack sidecar:", err);
    return c.json({ error: "Sidecar source unavailable" }, 404);
  }

  return c.body(Buffer.concat(chunks), 200, {
    "Content-Type": "application/x-tar",
    "Cache-Control": "no-store",
  });
});

export default app;
