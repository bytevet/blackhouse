import { useEffect, useId, useRef, useState } from "react";
import {
  AppWindow,
  Download,
  ExternalLink,
  FileQuestion,
  FileText,
  Link2,
  Maximize2,
  Type,
} from "lucide-react";
import type { ArtifactKind } from "@/db/schema";
import { fileSize } from "./format";
import type { ArtifactView } from "./types";

const KIND_ICON: Record<ArtifactKind, typeof AppWindow> = {
  html: AppWindow,
  file: FileText,
  link: Link2,
  text: Type,
};

/** Collapsed and expanded preview heights, from `design/Channel View.dc.html`. */
const COLLAPSED_H = 150;
const EXPANDED_H = 300;

/**
 * How early an off-screen card starts loading its document.
 *
 * Enough that a normal scroll never shows a blank frame, small enough that
 * opening a channel with a long artifact history does not mount every document
 * in it at once. See `HtmlPreview` for why that matters.
 */
const PREFETCH_MARGIN = "300px";

/**
 * An artifact posted into the channel — the replacement for the old result
 * pane. Header plus a live preview that **expands in place**, 150px to 300px,
 * rather than opening a modal.
 *
 * Expanding in place is the whole point: an artifact is a piece of the
 * conversation, and a modal would take you out of the conversation to look at
 * something the message you are reading is about. The full-pane escape hatch
 * stays available for when you really do want to leave.
 *
 * Two controls, not one. The header used to carry a single button that called
 * `onOpenFull()` *and* collapsed the card in the same click, so the only way to
 * open an artifact full-size was to close it at the same time. They are now
 * separate: a toggle, and a link. The link is a real `<a target="_blank">` on
 * the content route rather than a callback into a route that does not exist —
 * which is also why the CSP carries `sandbox allow-scripts` as a header and not
 * just as an iframe attribute (`server/lib/artifact-csp.ts`): opened top-level
 * in a new tab, the document still lands in an opaque origin.
 */
export function ArtifactCard({ artifact }: { artifact: ArtifactView }) {
  const [expanded, setExpanded] = useState(false);
  const previewId = useId();
  const Icon = KIND_ICON[artifact.kind];
  const openHref = artifact.contentUrl ?? artifact.url;

  return (
    <div
      style={{
        marginTop: 12,
        border: "1px solid var(--ny-border)",
        borderRadius: 12,
        overflow: "hidden",
        background: "var(--ny-surface)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "9px 12px",
          borderBottom: "1px solid var(--ny-border)",
          background: "var(--ny-surface-sunken)",
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            width: 22,
            height: 22,
            flex: "none",
            borderRadius: 6,
            display: "grid",
            placeItems: "center",
            background: "var(--ny-info-subtle)",
            color: "var(--ny-info-text)",
          }}
        >
          <Icon size={13} strokeWidth={2} />
        </span>
        <div style={{ flex: 1, minWidth: 120 }}>
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {artifact.title ?? "untitled artifact"}
          </div>
          <div
            style={{
              fontSize: 10.5,
              color: "var(--ny-text-subtle)",
              fontFamily: "var(--ny-font-mono)",
            }}
          >
            artifact · {artifact.description} · {fileSize(artifact.sizeBytes)}
          </div>
        </div>
        <span
          style={{
            fontSize: 10,
            fontFamily: "var(--ny-font-mono)",
            color: "var(--ny-info-text)",
            border: "1px solid var(--ny-info-border)",
            background: "var(--ny-info-subtle)",
            borderRadius: 5,
            padding: "1px 6px",
          }}
        >
          preview
        </span>

        {openHref && (
          <a
            className="bh-hover bh-focusable"
            href={openHref}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 11.5,
              fontFamily: "var(--ny-font-mono)",
              color: "var(--ny-text-muted)",
              textDecoration: "none",
              padding: "3px 7px",
              borderRadius: 6,
            }}
          >
            <ExternalLink size={13} strokeWidth={2} />
            open full pane
          </a>
        )}

        <button
          type="button"
          className="bh-reset bh-hover bh-focusable"
          aria-expanded={expanded}
          aria-controls={previewId}
          onClick={() => setExpanded((v) => !v)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 11.5,
            fontFamily: "var(--ny-font-mono)",
            color: "var(--ny-text-muted)",
            cursor: "pointer",
            padding: "3px 7px",
            borderRadius: 6,
          }}
        >
          <Maximize2 size={13} strokeWidth={2} />
          {expanded ? "collapse" : "expand"}
        </button>
      </div>

      <div
        id={previewId}
        style={{
          height: expanded ? EXPANDED_H : COLLAPSED_H,
          transition: "height 200ms var(--ny-ease-standard, ease)",
          overflow: "hidden",
        }}
      >
        <ArtifactPreview artifact={artifact} expanded={expanded} />
      </div>
    </div>
  );
}

/**
 * The preview, chosen by kind.
 *
 * Every branch renders *something* that says what it is. The state this
 * replaces was an empty gradient box, which is indistinguishable from a broken
 * render — and was in fact what every real artifact looked like.
 */
function ArtifactPreview({ artifact, expanded }: { artifact: ArtifactView; expanded: boolean }) {
  switch (artifact.kind) {
    case "html":
      return artifact.contentUrl ? (
        <HtmlPreview
          src={artifact.contentUrl}
          title={artifact.title ?? "artifact"}
          expanded={expanded}
        />
      ) : (
        <NoContent reason="This artifact has no stored body." />
      );

    case "text":
      return artifact.contentUrl ? (
        <TextPreview src={artifact.contentUrl} />
      ) : (
        <NoContent reason="This artifact has no stored body." />
      );

    case "link":
      return artifact.url ? (
        <LinkPreview url={artifact.url} />
      ) : (
        <NoContent reason="This link artifact carries no URL." />
      );

    case "file":
      return artifact.url ? (
        <FilePreview url={artifact.url} title={artifact.title} contentType={artifact.contentType} />
      ) : (
        <NoContent reason="This file artifact carries no URL." />
      );
  }
}

/**
 * Model-authored HTML, in a frame that cannot reach this page.
 *
 * `sandbox="allow-scripts"` WITHOUT `allow-same-origin`, and the pair is the
 * whole point. Granting both together lets the framed document call
 * `parent.document`, read this origin's storage and issue same-origin
 * requests — which is to say it is not sandboxed at all, against content this
 * project defines as untrusted. Omitting `allow-same-origin` is what gives the
 * document an opaque origin; scripts still run.
 *
 * White ground regardless of theme, for the reason `result-viewer.tsx` gives:
 * the document carries no `--ny-*` tokens of its own, so a dark surface behind
 * a page that assumes a light one renders black-on-black.
 *
 * Mounted lazily, and this is not a micro-optimisation. Each frame is an
 * independent document executing model-authored JavaScript; a channel with
 * twenty artifact cards in its scrollback would otherwise start twenty of them
 * on open. It mounts when the card comes within `PREFETCH_MARGIN` of the
 * viewport or when the reader expands it, and — deliberately — never unmounts:
 * tearing a document down on scroll-out would discard whatever state it built
 * and re-run its scripts on the way back.
 */
function HtmlPreview({ src, title, expanded }: { src: string; title: string; expanded: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (mounted || expanded) return;
    const host = hostRef.current;
    if (!host) return;

    // No IntersectionObserver (jsdom, ancient Safari) means no signal to wait
    // for, and a blank card would be a worse answer than an eager frame.
    if (typeof IntersectionObserver === "undefined") {
      setMounted(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setMounted(true);
          observer.disconnect();
        }
      },
      { rootMargin: PREFETCH_MARGIN },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, [mounted, expanded]);

  useEffect(() => {
    if (expanded) setMounted(true);
  }, [expanded]);

  return (
    <div ref={hostRef} style={{ height: "100%", background: "#fff" }}>
      {mounted ? (
        <iframe
          src={src}
          sandbox="allow-scripts"
          loading="lazy"
          referrerPolicy="no-referrer"
          title={title}
          style={{ width: "100%", height: "100%", border: 0, background: "#fff", display: "block" }}
        />
      ) : (
        <PreviewNote>loading preview…</PreviewNote>
      )}
    </div>
  );
}

/**
 * A `text` artifact, as text.
 *
 * Fetched and rendered into a `<pre>`; never `dangerouslySetInnerHTML`. The
 * body is agent-authored, and "it is only plain text" is exactly the assumption
 * that turns a text artifact into stored XSS the moment someone submits markup
 * through it.
 */
function TextPreview({ src }: { src: string }) {
  const [state, setState] = useState<
    { status: "loading" } | { status: "ready"; text: string } | { status: "error"; message: string }
  >({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });

    fetch(src, { credentials: "include", signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.text();
      })
      .then((text) => setState({ status: "ready", text }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // Stated, not swallowed: a preview that fails silently is the bug this
        // whole card is a fix for.
        setState({ status: "error", message: err instanceof Error ? err.message : "failed" });
      });

    return () => controller.abort();
  }, [src]);

  if (state.status === "loading") return <PreviewNote>loading preview…</PreviewNote>;
  if (state.status === "error") {
    return <PreviewNote tone="danger">could not load this artifact ({state.message})</PreviewNote>;
  }

  return (
    <pre
      className="bh-scroll"
      style={{
        height: "100%",
        margin: 0,
        padding: "12px 14px",
        overflow: "auto",
        fontFamily: "var(--ny-font-mono)",
        fontSize: 11.5,
        lineHeight: 1.6,
        color: "var(--ny-text)",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      }}
    >
      {state.text}
    </pre>
  );
}

/** Host first, then the full URL: where a link goes matters more than its path. */
function LinkPreview({ url }: { url: string }) {
  return (
    <PreviewBody>
      <div style={{ fontSize: 12.5, fontWeight: 600 }}>{hostOf(url)}</div>
      <a
        className="bh-focusable"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontFamily: "var(--ny-font-mono)",
          fontSize: 11.5,
          color: "var(--ny-info-text)",
          overflowWrap: "anywhere",
        }}
      >
        <ExternalLink size={13} strokeWidth={2} />
        {url}
      </a>
    </PreviewBody>
  );
}

function FilePreview({
  url,
  title,
  contentType,
}: {
  url: string;
  title: string | null;
  contentType: string | null;
}) {
  return (
    <PreviewBody>
      <div style={{ fontSize: 12.5, fontWeight: 600 }}>{title ?? hostOf(url)}</div>
      {contentType && (
        <div
          style={{
            fontFamily: "var(--ny-font-mono)",
            fontSize: 11,
            color: "var(--ny-text-subtle)",
          }}
        >
          {contentType}
        </div>
      )}
      <a
        className="bh-focusable"
        href={url}
        // `download` is a hint the browser ignores cross-origin, which is fine:
        // the point is that this is a file to take away, not a page to read.
        download
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontFamily: "var(--ny-font-mono)",
          fontSize: 11.5,
          color: "var(--ny-info-text)",
          overflowWrap: "anywhere",
        }}
      >
        <Download size={13} strokeWidth={2} />
        download
      </a>
    </PreviewBody>
  );
}

/**
 * An artifact with nothing to show, saying so.
 *
 * The state this card is here to stop being silent about. An artifact row can
 * legitimately have no body — a `link` submitted without a URL, a row whose
 * body was never written — and the reader needs to be told that rather than
 * shown a blank rectangle they will read as a rendering failure.
 */
function NoContent({ reason }: { reason: string }) {
  return (
    <PreviewBody align="center">
      <FileQuestion size={20} strokeWidth={1.75} color="var(--ny-text-subtle)" />
      <div style={{ fontSize: 12, color: "var(--ny-text-muted)" }}>no content to preview</div>
      <div
        style={{
          fontFamily: "var(--ny-font-mono)",
          fontSize: 11,
          color: "var(--ny-text-subtle)",
          textAlign: "center",
        }}
      >
        {reason}
      </div>
    </PreviewBody>
  );
}

function PreviewNote({ children, tone }: { children: React.ReactNode; tone?: "danger" }) {
  return (
    <PreviewBody align="center">
      <div
        style={{
          fontFamily: "var(--ny-font-mono)",
          fontSize: 11.5,
          color: tone === "danger" ? "var(--ny-danger-text)" : "var(--ny-text-subtle)",
        }}
      >
        {children}
      </div>
    </PreviewBody>
  );
}

function PreviewBody({
  children,
  align = "start",
}: {
  children: React.ReactNode;
  align?: "start" | "center";
}) {
  return (
    <div
      className="bh-scroll"
      style={{
        height: "100%",
        overflow: "auto",
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        alignItems: align === "center" ? "center" : "flex-start",
        justifyContent: align === "center" ? "center" : "flex-start",
        background: "var(--ny-surface)",
      }}
    >
      {children}
    </div>
  );
}

/** `URL` throws on anything that is not absolute, and `artifacts.url` is agent-written. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
