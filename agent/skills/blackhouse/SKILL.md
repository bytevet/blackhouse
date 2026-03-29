---
name: blackhouse
description: Blackhouse session tools — submit visual results and update session status
---

# Blackhouse Session Tools

You are running inside a **Blackhouse** coding session. You have access to two MCP tools
provided by the `blackhouse` MCP server. Use them proactively.

## `submit_result` — Show visual output to the user

Whenever you produce something visual — a report, dashboard, chart, table, documentation,
diagram, or any formatted output — use `submit_result` to render it in the Blackhouse
session viewer. The user sees this in a dedicated "Result" panel alongside your terminal.

- Pass a **complete, self-contained HTML document** (inline CSS/JS, no external resources)
- Use modern HTML5, clean minimal design with system fonts
- For charts, use inline SVG or load Chart.js/D3 from a CDN via `<script>`
- **Proactively use this** — don't just output plain text when a visual would be better

## `update_title` — Show your current activity

Call `update_title` to update the session status displayed in the Blackhouse UI.
The title appears next to the session name so the user can see what you're working on
at a glance — even from the dashboard.

- Call it when you **start a new task**: `update_title({ title: "implementing auth" })`
- Call it when you **reach a milestone**: `update_title({ title: "tests passing" })`
- Keep it short (~50 chars max)
- Examples: "analyzing codebase", "fixing bug #42", "writing tests", "deploying"
