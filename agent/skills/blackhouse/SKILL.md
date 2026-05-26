---
name: blackhouse
description: Submit HTML results and status updates to Blackhouse, and drive the embedded browser. USE THIS for any visual output, previews, HTML files, games, reports, charts; and when you need to open a URL, use the embedded browser — never assume there's a desktop or default OS browser.
---

# Blackhouse Session Tools

**You are running inside a Blackhouse session.** There is no desktop and no default OS browser, but Blackhouse provides an **embedded headless browser** as a session tab. The user sees:

- Whatever you submit via `submit-result.sh` in the **Result** tab.
- Whatever you navigate to via `browser.sh` (or any tool that opens `$BROWSER`) in the **Browser** tab.

Commands like `open`, `sensible-browser`, or `python -m http.server` will not work the way they do on a workstation — but `xdg-open <url>` and any tool that respects the `BROWSER` env var **will** route the URL into the embedded browser, because `BROWSER` is set to a shim that calls into `browser.sh navigate`.

## MANDATORY WORKFLOWS

1. **Any HTML artifact → pipe to `submit-result.sh` immediately.** Do not ask the user to open it; do not suggest viewing it locally. Submit it.
2. **Need to open a URL?** Use `browser.sh navigate <url>` (or simply `xdg-open <url>` — the shim points to us). The user sees the page in the Browser tab in real time.
3. **Update your status frequently** with `update-title.sh` so the user knows what step you're on.

```bash
# HTML you generated → Result tab
cat report.html | bash ~/.agents/skills/blackhouse/submit-result.sh

# Live web page → Browser tab
bash ~/.agents/skills/blackhouse/browser.sh navigate https://example.com
```

## submit-result.sh — Submit visual results

Sends HTML to the Blackhouse result viewer. Use for:

- **HTML files** — any `.html` file you create or modify, submit it
- **Games & demos** — interactive pages, 2048, snake, whatever
- **Reports & analysis** — tables, summaries, formatted output
- **Charts & dashboards** — SVG, Chart.js, D3 visualizations
- **Previews** — quick mockups, styled content, formatted data

```bash
# Submit an existing file
cat path/to/file.html | bash ~/.agents/skills/blackhouse/submit-result.sh

# Submit inline HTML
cat <<'HTML' | bash ~/.agents/skills/blackhouse/submit-result.sh
<html>
<head><style>body { font-family: system-ui; padding: 2rem; }</style></head>
<body>
  <h1>Results</h1>
  <p>Your content here</p>
</body>
</html>
HTML
```

Requirements:

- HTML must be a complete, self-contained document
- Include all CSS and JS inline (no external resources)
- For charts, load libraries from CDN via `<script src="...">`

## browser.sh — Drive the embedded browser

Subcommands:

```bash
browser.sh navigate <url>   # Load a URL
browser.sh back             # Back one history step
browser.sh forward          # Forward one history step
browser.sh reload           # Reload current page
```

The shim at `$BROWSER` (`/opt/blackhouse/browser-shim.sh`) routes any tool that opens URLs through this skill. So `gh repo view --web`, `npm docs <pkg>`, dev-server "view in browser" prompts, and `xdg-open` all land in the Blackhouse Browser tab automatically.

```bash
# Use the shim explicitly when scripting
"$BROWSER" https://example.com

# Or call the skill directly
bash ~/.agents/skills/blackhouse/browser.sh navigate https://example.com
```

The Browser tab also includes a **Console** panel showing the page's `console.log` output and any thrown exceptions — useful for debugging dev servers and SPAs you've built.

## update-title.sh — Update session status

Shows what you're doing in the Blackhouse UI header. Call this frequently.

```bash
bash ~/.agents/skills/blackhouse/update-title.sh "analyzing codebase"
bash ~/.agents/skills/blackhouse/update-title.sh "building 2048 game"
bash ~/.agents/skills/blackhouse/update-title.sh "tests passing, submitting results"
```

## Environment

| Variable         | Set by     | What it does                                                                                     |
| ---------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| `BLACKHOUSE_URL` | entrypoint | URL of the Blackhouse server for result/title submission                                         |
| `SESSION_ID`     | entrypoint | This session's ID                                                                                |
| `SESSION_TOKEN`  | entrypoint | Per-session auth token for the result/title endpoints                                            |
| `BROWSER`        | Dockerfile | Path to `browser-shim.sh` — tools that respect `$BROWSER` route to the embedded browser via this |
