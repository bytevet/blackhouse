import { describe, it, expect } from "vitest";
import {
  encodeInjection,
  planInjection,
  normalizePromptText,
  chunkUtf8,
  PASTE_START,
  PASTE_END,
} from "../../server/agents/injector";
import { PROFILES, getProfile, type AdapterProfile } from "../../server/agents/adapters/profiles";

const ESC = 0x1b;

/** Deterministic profile so golden sequences are readable. */
const profile: AdapterProfile = {
  ...PROFILES["claude-code"],
  chunkBytes: 8,
  chunkDelayMs: 20,
  postInterruptMs: 300,
  preSubmitMs: 200,
};

const concat = (chunks: Buffer[]) => Buffer.concat(chunks);
const hex = (chunks: Buffer[]) => concat(chunks).toString("hex");

describe("encodeInjection — golden byte sequences", () => {
  it("queue mode wraps the body in bracketed paste and submits with CR", () => {
    const chunks = encodeInjection("hi", PROFILES["claude-code"], { mode: "queue" });

    expect(chunks.map((c) => c.toString("latin1"))).toEqual(["\x1b[200~", "hi", "\x1b[201~", "\r"]);
    expect(hex(chunks)).toBe(Buffer.from("\x1b[200~hi\x1b[201~\r", "latin1").toString("hex"));
  });

  it("interrupt mode prefixes the profile's interrupt key before the paste", () => {
    const chunks = encodeInjection("hi", PROFILES["claude-code"], { mode: "interrupt" });

    expect(chunks[0]).toEqual(Buffer.from([ESC]));
    expect(chunks[0].length).toBe(1);
    expect(concat(chunks).toString("latin1")).toBe("\x1b\x1b[200~hi\x1b[201~\r");
  });

  it("uses the adapter's own interrupt key — Antigravity interrupts on Ctrl-C", () => {
    const chunks = encodeInjection("hi", PROFILES.antigravity, { mode: "interrupt" });
    expect(chunks[0]).toEqual(Buffer.from([0x03]));
  });

  it("waits postInterruptMs after the interrupt and preSubmitMs before the CR", () => {
    const steps = planInjection("hi", profile, { mode: "interrupt" });

    expect(steps.map((s) => [s.kind, s.delayAfterMs])).toEqual([
      ["interrupt", 300],
      ["paste-start", 0],
      ["body", 0],
      ["paste-end", 200],
      ["submit", 0],
    ]);
  });

  it("emits no interrupt bytes in queue mode", () => {
    const steps = planInjection("hi", profile, { mode: "queue" });
    expect(steps.some((s) => s.kind === "interrupt")).toBe(false);
    expect(steps[0].bytes).toEqual(PASTE_START);
  });

  it("omits the submit key when submit: false", () => {
    const steps = planInjection("hi", profile, { submit: false });
    expect(steps.some((s) => s.kind === "submit")).toBe(false);
    expect(steps[steps.length - 1].bytes).toEqual(PASTE_END);
    expect(steps[steps.length - 1].delayAfterMs).toBe(0);
  });

  it("skips bracketed paste for the BYO/custom profile", () => {
    const chunks = encodeInjection("hi", PROFILES.custom, { mode: "queue" });
    expect(concat(chunks).toString("latin1")).toBe("hi\r");
  });

  it("interrupt-only injection for empty text still stops the agent", () => {
    expect(encodeInjection("", profile, { mode: "interrupt" })).toEqual([Buffer.from([ESC])]);
    expect(encodeInjection("", profile, { mode: "queue" })).toEqual([]);
    expect(encodeInjection("   \n\n", profile, { mode: "queue" }).length).toBeGreaterThan(0);
  });
});

describe("chunking", () => {
  it("chunks the body at profile.chunkBytes with a gap after each", () => {
    const body = "a".repeat(20); // 8 + 8 + 4
    const steps = planInjection(body, profile);
    const bodySteps = steps.filter((s) => s.kind === "body");

    expect(bodySteps.map((s) => s.bytes.length)).toEqual([8, 8, 4]);
    expect(bodySteps.map((s) => s.delayAfterMs)).toEqual([20, 20, 0]);
    expect(Buffer.concat(bodySteps.map((s) => s.bytes)).toString()).toBe(body);
  });

  it("chunks a multi-KB paste rather than issuing one huge write", () => {
    const body = "x".repeat(10_000);
    const steps = planInjection(body, PROFILES["claude-code"]).filter((s) => s.kind === "body");

    expect(steps.length).toBe(5); // 2048 * 4 + 1808
    expect(steps.every((s) => s.bytes.length <= 2048)).toBe(true);
    expect(Buffer.concat(steps.map((s) => s.bytes)).toString()).toBe(body);
  });

  it("paste markers are never merged into a body chunk", () => {
    const steps = planInjection("a".repeat(20), profile);
    expect(steps[0].bytes).toEqual(PASTE_START);
    expect(steps[steps.length - 2].bytes).toEqual(PASTE_END);
  });

  it("never splits a multi-byte UTF-8 sequence across chunks", () => {
    // 'é' is 2 bytes; a size-3 chunk would cut the 4th char in half.
    const chunks = chunkUtf8(Buffer.from("ééé", "utf-8"), 3);
    expect(chunks.map((c) => c.length)).toEqual([2, 2, 2]);
    expect(chunks.every((c) => c.toString("utf-8") === "é")).toBe(true);

    const emoji = chunkUtf8(Buffer.from("🙂🙂", "utf-8"), 5);
    expect(emoji.map((c) => c.length)).toEqual([4, 4]);
    expect(Buffer.concat(emoji).toString("utf-8")).toBe("🙂🙂");
  });

  it("chunk sizes are exact and lossless for arbitrary ascii lengths", () => {
    for (const len of [1, 7, 8, 9, 16, 17]) {
      const body = "b".repeat(len);
      const out = chunkUtf8(Buffer.from(body), 8);
      expect(Buffer.concat(out).toString()).toBe(body);
      expect(out.every((c) => c.length <= 8)).toBe(true);
    }
  });
});

describe("normalizePromptText", () => {
  it("normalizes CRLF and lone CR to LF", () => {
    expect(normalizePromptText("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("keeps a CR from reaching the PTY as an early submit", () => {
    const bytes = Buffer.concat(encodeInjection("line1\r\nline2", PROFILES["claude-code"]));
    // exactly one CR, the deliberate submit at the very end
    expect([...bytes].filter((b) => b === 0x0d)).toHaveLength(1);
    expect(bytes[bytes.length - 1]).toBe(0x0d);
    expect(bytes.toString("latin1")).toContain("line1\nline2");
  });

  it("strips ESC so prompt text cannot escape paste mode or press keys", () => {
    const hostile = "ok\x1b[201~\rrm -rf /\x1b";
    expect(normalizePromptText(hostile)).toBe("ok[201~\nrm -rf /");

    const bytes = Buffer.concat(encodeInjection(hostile, PROFILES["claude-code"]));
    expect([...bytes].filter((b) => b === ESC)).toHaveLength(2); // paste start + end only
  });

  it("keeps tabs and newlines, drops other C0 controls", () => {
    expect(normalizePromptText("a\tb\nc\x00\x07d")).toBe("a\tb\ncd");
  });

  it("trims trailing newlines so the paste does not self-submit", () => {
    expect(normalizePromptText("prompt\n\n")).toBe("prompt");
    expect(normalizePromptText("\nprompt")).toBe("\nprompt");
  });
});

describe("getProfile", () => {
  it("resolves known adapters and defaults unknown ones to custom", () => {
    expect(getProfile("codex").id).toBe("codex");
    expect(getProfile("mystery-cli").id).toBe("custom");
    expect(getProfile(null).id).toBe("claude-code");
  });

  it("every profile can produce a submittable injection", () => {
    for (const p of Object.values(PROFILES)) {
      const bytes = Buffer.concat(encodeInjection("hello", p, { mode: "interrupt" }));
      expect(bytes.subarray(0, p.interruptBytes.length)).toEqual(p.interruptBytes);
      expect(bytes.subarray(bytes.length - p.submitBytes.length)).toEqual(p.submitBytes);
      expect(bytes.toString("utf-8")).toContain("hello");
    }
  });
});
