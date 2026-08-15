import type { ReactNode } from "react";
import { CodeBlock } from "./code-block";

/**
 * A deliberately small markdown subset for agent prose: paragraphs, bullet and
 * numbered lists, fenced code, inline code, and bold.
 *
 * No markdown dependency is installed and adding one is out of scope for this
 * phase, but the real reason to keep it small is safety: agent output is
 * untrusted text, and this renderer produces React nodes only — there is no
 * `dangerouslySetInnerHTML` anywhere in the transcript, so a model that emits
 * `<script>` renders it as the characters it typed.
 */

type Block =
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; lang?: string; code: string };

function parseBlocks(source: string): Block[] {
  const lines = source.split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^```(\w+)?\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      blocks.push({ type: "code", lang: fence[1], code: body.join("\n") });
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      const items = [(bullet ?? numbered)![1]];
      while (i + 1 < lines.length) {
        const next = ordered
          ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[i + 1])
          : /^\s*[-*]\s+(.*)$/.exec(lines[i + 1]);
        if (!next) break;
        items.push(next[1]);
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    if (line.trim() === "") flushParagraph();
    else paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}

/** Inline `code` and **bold**, in that order — code spans win, as in markdown. */
function inline(text: string): ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.filter(Boolean).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return <InlineCode key={i}>{part.slice(1, -1)}</InlineCode>;
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 3) {
      return (
        <strong key={i} style={{ fontWeight: 700 }}>
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export function InlineCode({ children }: { children: ReactNode }) {
  return (
    <code
      style={{
        fontFamily: "var(--ny-font-mono)",
        fontSize: 12.5,
        background: "var(--ny-surface-sunken)",
        border: "1px solid var(--ny-border)",
        borderRadius: 4,
        padding: "1px 5px",
      }}
    >
      {children}
    </code>
  );
}

export function Markdown({ source }: { source: string }) {
  const blocks = parseBlocks(source);
  return (
    <div style={{ lineHeight: 1.6, color: "var(--ny-text)" }}>
      {blocks.map((block, i) => {
        const last = i === blocks.length - 1;
        if (block.type === "code") {
          return (
            <div key={i} style={{ margin: last ? "0" : "0 0 10px" }}>
              <CodeBlock code={block.code} lang={block.lang} />
            </div>
          );
        }
        if (block.type === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List
              key={i}
              style={{ margin: last ? 0 : "0 0 12px", paddingLeft: 20, lineHeight: 1.75 }}
            >
              {block.items.map((item, j) => (
                <li key={j}>{inline(item)}</li>
              ))}
            </List>
          );
        }
        return (
          <p key={i} style={{ margin: last ? 0 : "0 0 10px" }}>
            {inline(block.text)}
          </p>
        );
      })}
    </div>
  );
}
