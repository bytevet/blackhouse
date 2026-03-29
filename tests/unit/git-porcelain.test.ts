import { describe, it, expect } from "vitest";
import { parseGitPorcelain } from "../../server/api/files";

const ROOT = "/workspace/myrepo";

describe("parseGitPorcelain", () => {
  it("parses unstaged modified files", () => {
    const output = " M Cargo.toml\n M src/lib.rs\n";
    const map = parseGitPorcelain(output, ROOT, ROOT);

    expect(map[`${ROOT}/Cargo.toml`]).toBe("M");
    expect(map[`${ROOT}/src/lib.rs`]).toBe("M");
    expect(map["Cargo.toml"]).toBe("M");
    expect(map["src"]).toBe("M");
  });

  it("parses staged modified files", () => {
    const output = "M  staged.rs\n";
    const map = parseGitPorcelain(output, ROOT, ROOT);

    expect(map[`${ROOT}/staged.rs`]).toBe("M");
    expect(map["staged.rs"]).toBe("M");
  });

  it("parses both staged and unstaged (MM)", () => {
    const output = "MM both.ts\n";
    const map = parseGitPorcelain(output, ROOT, ROOT);

    expect(map[`${ROOT}/both.ts`]).toBe("MM");
    expect(map["both.ts"]).toBe("MM");
  });

  it("parses untracked files", () => {
    const output = "?? newfile.html\n";
    const map = parseGitPorcelain(output, ROOT, ROOT);

    expect(map[`${ROOT}/newfile.html`]).toBe("??");
    expect(map["newfile.html"]).toBe("??");
  });

  it("parses added files", () => {
    const output = "A  added.txt\n";
    const map = parseGitPorcelain(output, ROOT, ROOT);

    expect(map[`${ROOT}/added.txt`]).toBe("A");
    expect(map["added.txt"]).toBe("A");
  });

  it("parses deleted files", () => {
    const output = " D removed.rs\n";
    const map = parseGitPorcelain(output, ROOT, ROOT);

    expect(map[`${ROOT}/removed.rs`]).toBe("D");
    expect(map["removed.rs"]).toBe("D");
  });

  it("parses renamed files (uses new path)", () => {
    const output = "R  old.rs -> new.rs\n";
    const map = parseGitPorcelain(output, ROOT, ROOT);

    expect(map[`${ROOT}/new.rs`]).toBe("R");
    expect(map["new.rs"]).toBe("R");
    expect(map[`${ROOT}/old.rs`]).toBeUndefined();
  });

  it("marks parent directories as modified", () => {
    const output = " M src/deeply/nested/file.rs\n";
    const map = parseGitPorcelain(output, ROOT, ROOT);

    expect(map[`${ROOT}/src`]).toBe("M");
    expect(map[`${ROOT}/src/deeply`]).toBe("M");
    expect(map[`${ROOT}/src/deeply/nested`]).toBe("M");
    expect(map[`${ROOT}/src/deeply/nested/file.rs`]).toBe("M");
    // Direct child of listed dir
    expect(map["src"]).toBe("M");
  });

  it("handles mixed statuses", () => {
    const output = [" M Cargo.toml", " M src/lib.rs", "?? game.html", " D old.txt", ""].join("\n");
    const map = parseGitPorcelain(output, ROOT, ROOT);

    expect(map["Cargo.toml"]).toBe("M");
    expect(map["src"]).toBe("M");
    expect(map["game.html"]).toBe("??");
    expect(map["old.txt"]).toBe("D");
  });

  it("handles listing a subdirectory", () => {
    const output = " M src/lib.rs\n M src/tags.rs\n?? src/new.rs\n";
    const map = parseGitPorcelain(output, ROOT, `${ROOT}/src`);

    // By absolute path
    expect(map[`${ROOT}/src/lib.rs`]).toBe("M");
    // By direct child name relative to listPath
    expect(map["lib.rs"]).toBe("M");
    expect(map["tags.rs"]).toBe("M");
    expect(map["new.rs"]).toBe("??");
  });

  it("ignores files outside the listed subdirectory", () => {
    const output = " M Cargo.toml\n M src/lib.rs\n";
    const map = parseGitPorcelain(output, ROOT, `${ROOT}/src`);

    // Cargo.toml is not a child of src/
    expect(map["Cargo.toml"]).toBeUndefined();
    // But still accessible by absolute path
    expect(map[`${ROOT}/Cargo.toml`]).toBe("M");
    // src/lib.rs is a direct child
    expect(map["lib.rs"]).toBe("M");
  });

  it("handles empty output", () => {
    const map = parseGitPorcelain("", ROOT, ROOT);
    expect(Object.keys(map)).toHaveLength(0);
  });

  it("handles trailing newlines and blank lines", () => {
    const output = "\n M file.rs\n\n";
    const map = parseGitPorcelain(output, ROOT, ROOT);

    expect(map["file.rs"]).toBe("M");
    expect(Object.keys(map)).toHaveLength(2); // absolute + name
  });

  it("handles listPath with trailing slash", () => {
    const output = " M file.rs\n";
    const map = parseGitPorcelain(output, ROOT, `${ROOT}/`);

    expect(map["file.rs"]).toBe("M");
  });

  it("preserves first status for directory with multiple changed files", () => {
    const output = "?? src/new.rs\n M src/lib.rs\n";
    const map = parseGitPorcelain(output, ROOT, ROOT);

    // src directory gets the first status encountered (??)
    expect(map["src"]).toBe("??");
    // Individual files still have their own status
    expect(map[`${ROOT}/src/new.rs`]).toBe("??");
    expect(map[`${ROOT}/src/lib.rs`]).toBe("M");
  });
});
