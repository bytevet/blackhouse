import { describe, it, expect } from "vitest";
import {
  stripAnsi,
  toLines,
  isNoise,
  initialScrapeState,
  feedScrape,
  tickScrape,
  isQuiescent,
  DEFAULT_SCRAPE_CONFIG,
} from "../../server/agents/pty-scrape.js";

describe("stripAnsi", () => {
  it("removes SGR colour codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
  });

  it("removes cursor movement and erase sequences", () => {
    expect(stripAnsi("\x1b[2J\x1b[H\x1b[Kdone")).toBe("done");
  });

  it("removes OSC window-title sequences terminated by BEL or ST", () => {
    expect(stripAnsi("\x1b]0;title\x07text")).toBe("text");
    expect(stripAnsi("\x1b]8;;http://x\x1b\\link")).toBe("link");
  });

  it("removes the bracketed-paste markers we emit during injection", () => {
    // Otherwise our own injected prompt would come back as transcript text.
    expect(stripAnsi("\x1b[200~hello\x1b[201~")).toBe("hello");
  });

  it("keeps tabs and newlines but drops other control characters", () => {
    expect(stripAnsi("a\tb\nc\x00d\x07")).toBe("a\tb\ncd");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("just text")).toBe("just text");
  });
});

describe("toLines", () => {
  it("splits on newlines and drops blank lines", () => {
    expect(toLines("a\n\nb\n")).toEqual(["a", "b"]);
  });

  it("normalises CRLF", () => {
    expect(toLines("a\r\nb")).toEqual(["a", "b"]);
  });

  it("keeps only what survived a carriage-return rewrite", () => {
    // TUIs redraw a line in place with \r; the last write is what is on screen.
    expect(toLines("50%\r75%\r100%")).toEqual(["100%"]);
  });

  it("strips trailing whitespace used for padding", () => {
    expect(toLines("text     \nmore\t\t")).toEqual(["text", "more"]);
  });
});

describe("isNoise", () => {
  it("treats spinner and separator frames as noise", () => {
    expect(isNoise("⠋")).toBe(true);
    expect(isNoise("---")).toBe(true);
    expect(isNoise("...")).toBe(true);
    expect(isNoise("")).toBe(true);
  });

  it("does not discard real output", () => {
    expect(isNoise("Reading src/db/schema.ts")).toBe(false);
    expect(isNoise("34 passed")).toBe(false);
  });
});

describe("scrape state machine", () => {
  const cfg = DEFAULT_SCRAPE_CONFIG;

  it("opens a turn on the first meaningful output", () => {
    const s = initialScrapeState(0);
    const events = feedScrape(s, "working on it\n", 100, cfg);
    expect(events).toEqual([{ type: "turn_start", at: 100 }]);
    expect(s.busy).toBe(true);
  });

  it("does not open a turn on spinner noise alone", () => {
    const s = initialScrapeState(0);
    expect(feedScrape(s, "\x1b[36m⠋\x1b[0m\n", 100, cfg)).toEqual([]);
    expect(s.busy).toBe(false);
  });

  it("opens the turn only once across several chunks", () => {
    const s = initialScrapeState(0);
    feedScrape(s, "first\n", 100, cfg);
    expect(feedScrape(s, "second\n", 200, cfg)).toEqual([]);
  });

  it("dedupes consecutive identical redraws", () => {
    const s = initialScrapeState(0);
    feedScrape(s, "Thinking\n", 100, cfg);
    feedScrape(s, "Thinking\n", 150, cfg);
    feedScrape(s, "Thinking\n", 200, cfg);
    expect(s.buffer).toEqual(["Thinking"]);
  });

  it("does not close the turn while output is still arriving", () => {
    const s = initialScrapeState(0);
    feedScrape(s, "line\n", 100, cfg);
    expect(tickScrape(s, 100 + cfg.quiescenceMs - 1, cfg)).toBeNull();
  });

  it("closes the turn once output has been quiet long enough", () => {
    const s = initialScrapeState(0);
    feedScrape(s, "did a thing\n", 100, cfg);
    const closed = tickScrape(s, 100 + cfg.quiescenceMs, cfg);
    expect(closed?.text).toBe("did a thing");
    expect(s.busy).toBe(false);
    expect(s.buffer).toEqual([]);
  });

  it("returns null when there is no turn open", () => {
    expect(tickScrape(initialScrapeState(0), 10_000, cfg)).toBeNull();
  });

  it("caps the buffer so a runaway process cannot exhaust memory", () => {
    const s = initialScrapeState(0);
    const small = { ...cfg, maxBufferLines: 10 };
    for (let i = 0; i < 100; i += 1) feedScrape(s, `line ${i}\n`, 100 + i, small);
    expect(s.buffer).toHaveLength(10);
    // Keeps the tail: the end of a turn is what a reader wants.
    expect(s.buffer[s.buffer.length - 1]).toBe("line 99");
  });

  it("reports quiescence, which is the only idle signal a scraped CLI has", () => {
    const s = initialScrapeState(0);
    expect(isQuiescent(s, 0, cfg)).toBe(true);
    feedScrape(s, "busy now\n", 100, cfg);
    expect(isQuiescent(s, 200, cfg)).toBe(false);
    expect(isQuiescent(s, 100 + cfg.quiescenceMs, cfg)).toBe(true);
  });

  it("handles a full ANSI-laden frame end to end", () => {
    const s = initialScrapeState(0);
    const frame = "\x1b[2J\x1b[H\x1b[32m✓\x1b[0m Tests passed\r\n\x1b[90m34 total\x1b[0m\r\n";
    feedScrape(s, frame, 100, cfg);
    const closed = tickScrape(s, 100 + cfg.quiescenceMs, cfg);
    expect(closed?.text).toBe("✓ Tests passed\n34 total");
  });
});
