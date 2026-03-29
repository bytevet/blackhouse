---
name: blackhouse
description: Blackhouse session tools — submit visual results and update session status
---

# Blackhouse Session Tools

You are running inside a **Blackhouse** coding session. The following environment
variables are available: `SESSION_ID`, `BLACKHOUSE_URL`, `CONTAINER_TOKEN`.

## Submit Result — Show visual output to the user

Whenever you produce something visual — a report, dashboard, chart, table, documentation,
diagram, or any formatted output — submit it as HTML to the Blackhouse result viewer.
The user sees this in a dedicated "Result" panel alongside your terminal.

**Proactively use this** — don't just output plain text when a visual would be better.

```bash
curl -X POST "$BLACKHOUSE_URL/api/sessions/result" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\": \"$SESSION_ID\", \"token\": \"$CONTAINER_TOKEN\", \"html\": \"<html>YOUR HTML HERE</html>\"}"
```

- The HTML must be a **complete, self-contained document** (inline CSS/JS, no external resources)
- Use modern HTML5, clean minimal design with system fonts
- For charts, use inline SVG or load Chart.js/D3 from a CDN via `<script>`

## Update Title — Show your current activity

Update the session title to show what you are currently working on. The title is displayed
next to the session name in the Blackhouse UI, so the user can see your progress at a glance.

```bash
curl -X POST "$BLACKHOUSE_URL/api/sessions/title" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\": \"$SESSION_ID\", \"token\": \"$CONTAINER_TOKEN\", \"title\": \"YOUR STATUS HERE\"}"
```

- Call it when you **start a new task**: `"implementing auth module"`
- Call it when you **reach a milestone**: `"tests passing"`
- Keep it short (~50 chars max)
- Examples: `"analyzing codebase"`, `"fixing bug #42"`, `"writing tests"`, `"deploying"`
