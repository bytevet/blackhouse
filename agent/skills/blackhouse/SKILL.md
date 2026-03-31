---
name: blackhouse
description: Submit HTML results and status updates to Blackhouse — USE THIS for any visual output, previews, HTML files, games, reports, charts. NEVER open a browser.
---

# Blackhouse Session Tools

**You are running inside a Blackhouse session.** There is NO browser, NO desktop, NO display server. Commands like `open`, `xdg-open`, `sensible-browser`, `python -m http.server` DO NOT WORK. The user views your output through a web-based result panel.

## MANDATORY WORKFLOW

Every time you create, modify, or encounter an HTML file → **pipe it to `submit-result.sh` immediately.** Do not ask the user to open it. Do not suggest viewing it locally. Submit it.

```bash
# Single HTML file? Submit it.
cat game.html | bash ~/.agents/skills/blackhouse/submit-result.sh

# Generated a report? Submit it.
cat report.html | bash ~/.agents/skills/blackhouse/submit-result.sh

# Built something visual? Submit it.
cat dashboard.html | bash ~/.agents/skills/blackhouse/submit-result.sh
```

The user sees the result **instantly** in their Blackhouse panel — rendered, interactive, fully functional.

## RULES

1. **NEVER** say "open this in a browser" or "view the file at localhost:..." — there is no browser.
2. **NEVER** use `open`, `xdg-open`, `python -m http.server`, or any local preview command.
3. **ALWAYS** submit HTML via `submit-result.sh` — this is the ONLY way the user can see visual output.
4. **ALWAYS** call `update-title.sh` when starting a task, finishing a step, or changing activity.
5. **BE PROACTIVE** — if you write ANY `.html` file, submit it without being asked.

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

## update-title.sh — Update session status

Shows what you're doing in the Blackhouse UI header. Call this frequently.

```bash
bash ~/.agents/skills/blackhouse/update-title.sh "analyzing codebase"
bash ~/.agents/skills/blackhouse/update-title.sh "building 2048 game"
bash ~/.agents/skills/blackhouse/update-title.sh "tests passing, submitting results"
```
