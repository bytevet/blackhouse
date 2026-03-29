---
name: blackhouse
description: Blackhouse session tools — submit visual results and update session status
---

# Blackhouse Session Tools

IMPORTANT: You are running inside a Blackhouse session. The user views your work through
a web-based terminal and result viewer. There is NO local browser or desktop — the user
CANNOT open files locally. You MUST use these tools to present any visual output.

The environment variables `SESSION_ID`, `BLACKHOUSE_URL`, and `SESSION_TOKEN` are already
configured. The scripts below use them automatically — just run the commands.

## CRITICAL RULES

- NEVER tell the user to "open a file in a browser" or use `open`, `xdg-open`, etc.
  There is no browser in this environment. Use `submit-result.sh` instead.
- ALWAYS submit HTML files, game demos, previews, reports, or any visual output
  via `submit-result.sh`. The user sees it instantly in the Blackhouse result panel.
- ALWAYS call `update-title.sh` when you start a task, finish a step, or change activity.

## When to use

ALWAYS use `submit-result.sh` when you:
- Create or modify an HTML file — submit it so the user can preview it
- Generate a report, summary, or analysis
- Build a chart, dashboard, table, or any visual artifact
- Write a game, demo, or interactive page
- Produce any output that benefits from rendering rather than raw text

ALWAYS use `update-title.sh` when you:
- Start working on a new task
- Complete a milestone or finish a step
- Switch to a different activity

## update-title.sh — Update session status

Shows what you're currently working on in the Blackhouse UI.

```bash
bash ~/.agents/skills/blackhouse/update-title.sh "your status here"
```

Examples:

```bash
bash ~/.agents/skills/blackhouse/update-title.sh "analyzing codebase"
bash ~/.agents/skills/blackhouse/update-title.sh "implementing auth module"
bash ~/.agents/skills/blackhouse/update-title.sh "fixing test failures"
bash ~/.agents/skills/blackhouse/update-title.sh "tests passing, cleaning up"
```

## submit-result.sh — Submit visual results

Sends HTML to the Blackhouse result viewer. The user sees it immediately in their browser.

To submit an existing HTML file:

```bash
cat path/to/file.html | bash ~/.agents/skills/blackhouse/submit-result.sh
```

To submit inline HTML:

```bash
cat <<'HTML' | bash ~/.agents/skills/blackhouse/submit-result.sh
<html>
<head><style>body { font-family: system-ui; padding: 2rem; }</style></head>
<body>
  <h1>Results</h1>
  <table>...</table>
</body>
</html>
HTML
```

Requirements:
- HTML must be a complete, self-contained document
- Include all CSS and JS inline (no external resources)
- Use modern HTML5 with clean, minimal design
- For charts, use inline SVG or load Chart.js/D3 from a CDN via `<script>`
